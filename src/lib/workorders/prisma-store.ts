import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { JobStageOrClosed, TradeStatus } from "../production/types.ts";
import type { Division } from "../rules.ts";
import type { MaterialLine, NewLine, SourceLine, WorkOrder, WorkOrderJob, WorkOrderStatus, WorkOrderStore, WorkOrderTrade, WorkOrderTx } from "./types.ts";

const UUID = /^[0-9a-f-]{36}$/i;
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

type Client = Pick<PrismaClient, "job" | "document" | "productionTrade" | "user" | "workOrder" | "workOrderLine" | "scopeItem" | "product">;

async function loadJob(c: Client, jobId: string): Promise<WorkOrderJob | null> {
  if (!UUID.test(jobId)) return null;
  const j = await c.job.findUnique({ where: { id: jobId }, include: { property: true } });
  if (!j) return null;
  const signed = await c.document.count({ where: { jobId, kind: "contract", status: "signed" } });
  return {
    id: j.id, jobNumber: j.jobNumber, stage: j.stage as JobStageOrClosed, estimatorId: j.estimatorId, divisions: j.divisions as Division[],
    address: `${j.property.street}, ${j.property.city}, ${j.property.state} ${j.property.zip}`, contractSigned: signed > 0,
  };
}

type OrderDb = {
  id: string; jobId: string; division: string; status: string; notes: string | null; createdAt: Date; issuedAt: Date | null;
  lines: { id: string; sortOrder: number; sourceItemId: string | null; description: string; quantity: { toString(): string }; unit: string; note: string | null }[];
};
const toOrder = (o: OrderDb): WorkOrder => ({
  id: o.id, jobId: o.jobId, division: o.division as Division, status: o.status as WorkOrderStatus, notes: o.notes, createdAt: o.createdAt, issuedAt: o.issuedAt,
  lines: [...o.lines].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => ({
    id: l.id, sortOrder: l.sortOrder, sourceItemId: l.sourceItemId, description: l.description, quantity: Number(l.quantity.toString()), unit: l.unit, note: l.note,
  })),
});

const listOrders = async (c: Client, jobId: string): Promise<WorkOrder[]> =>
  (await c.workOrder.findMany({ where: { jobId }, include: { lines: true } })).map(toOrder);

const chosen = (jobId: string, division: Division) => ({ scope: { jobId, division, selected: true } });

async function sourceLines(c: Client, jobId: string, division: Division): Promise<SourceLine[]> {
  const rows = await c.scopeItem.findMany({ where: { kind: { in: ["labor", "misc"] }, ...chosen(jobId, division) }, orderBy: { sortOrder: "asc" } });
  return rows.map((r) => ({ itemId: r.id, description: r.description, quantity: Number(r.quantity.toString()), unit: r.unit ?? "ea" }));
}

const colorsMissing = (c: Client, jobId: string, division: Division) =>
  c.scopeItem.count({ where: { kind: "material", OR: [{ color: null }, { color: "" }], ...chosen(jobId, division) } });

export function createPrismaWorkOrderStore(db: PrismaClient): WorkOrderStore {
  return {
    getJob: (jobId) => loadJob(db, jobId),

    async listTrades(jobId): Promise<WorkOrderTrade[]> {
      if (!UUID.test(jobId)) return [];
      const rows = await db.productionTrade.findMany({ where: { jobId } });
      const ids = [...new Set(rows.map((r) => r.crewLeaderId).filter((x): x is string => !!x))];
      const names = new Map((ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));
      return rows.map((r) => ({
        division: r.division as Division, status: r.status as TradeStatus, installDate: r.installDate ? dateStr(r.installDate) : null,
        crewLeaderId: r.crewLeaderId, crewLeaderName: r.crewLeaderId ? names.get(r.crewLeaderId) ?? null : null,
      }));
    },

    async pmDivisions(userId) {
      if (!UUID.test(userId)) return [];
      return [...new Set((await db.divisionManager.findMany({ where: { userId } })).map((r) => r.division as Division))];
    },

    listOrders: (jobId) => (UUID.test(jobId) ? listOrders(db, jobId) : Promise.resolve([])),

    async materials(jobId, division): Promise<MaterialLine[]> {
      if (!UUID.test(jobId)) return [];
      const rows = await db.scopeItem.findMany({ where: { kind: "material", ...chosen(jobId, division) }, orderBy: { sortOrder: "asc" } });
      const ids = [...new Set(rows.map((r) => r.productId).filter((x): x is string => !!x))];
      const units = new Map((ids.length ? await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, unit: true } }) : []).map((p) => [p.id, p.unit]));
      return rows.map((r) => ({ description: r.description, unit: (r.productId && units.get(r.productId)) || "ea", quantity: Number(r.quantity.toString()), color: r.color?.trim() || null }));
    },

    colorsMissing: (jobId, division) => (UUID.test(jobId) ? colorsMissing(db, jobId, division) : Promise.resolve(0)),

    async estimatorContact(jobId) {
      if (!UUID.test(jobId)) return null;
      const j = await db.job.findUnique({ where: { id: jobId }, select: { estimatorId: true } });
      if (!j?.estimatorId) return null;
      const u = await db.user.findUnique({ where: { id: j.estimatorId }, select: { email: true, fullName: true, active: true } });
      return u && u.active ? { email: u.email, name: u.fullName } : null;
    },

    async jobsNeedingColors() {
      const rows = await db.$queryRaw<{ job_id: string; missing: number }[]>`
        SELECT j.id AS job_id, count(*)::int AS missing
        FROM jobs j
        JOIN scopes s ON s.job_id = j.id AND s.selected
        JOIN scope_items i ON i.scope_id = s.id AND i.kind = 'material' AND (i.color IS NULL OR btrim(i.color) = '')
        WHERE j.materials_ordered_at IS NULL
          AND j.stage NOT IN ('lost', 'cancelled_after_approval')
          AND EXISTS (SELECT 1 FROM documents d WHERE d.job_id = j.id AND d.kind = 'contract' AND d.status = 'signed')
        GROUP BY j.id`;
      return rows.map((r) => ({ jobId: r.job_id, missing: r.missing }));
    },

    async transaction(jobId, fn) {
      return db.$transaction(async (tx) => {
        if (UUID.test(jobId)) await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
        const handle: WorkOrderTx = {
          getJob: () => loadJob(tx, jobId),
          listOrders: () => listOrders(tx, jobId),
          sourceLines: (division) => sourceLines(tx, jobId, division),
          colorsMissing: (division) => colorsMissing(tx, jobId, division),
          async insertOrder(division, lines: NewLine[], actorId) {
            await tx.workOrder.create({
              data: {
                jobId, division, createdBy: actorId,
                lines: { create: lines.map((l, i) => ({ sortOrder: i + 1, sourceItemId: l.sourceItemId, description: l.description, quantity: l.quantity, unit: l.unit, note: l.note })) },
              },
            });
          },
          async setNotes(orderId, notes) {
            await tx.workOrder.updateMany({ where: { id: orderId, jobId }, data: { notes } });
          },
          async addLine(orderId, line) {
            const last = await tx.workOrderLine.aggregate({ where: { workOrderId: orderId }, _max: { sortOrder: true } });
            await tx.workOrderLine.create({ data: { workOrderId: orderId, sortOrder: (last._max.sortOrder ?? 0) + 1, sourceItemId: line.sourceItemId, description: line.description, quantity: line.quantity, unit: line.unit, note: line.note } });
          },
          async setLineNote(orderId, lineId, note) {
            const r = await tx.workOrderLine.updateMany({ where: { id: lineId, workOrder: { id: orderId, jobId } }, data: { note } });
            return r.count === 1;
          },
          async removeHandLine(orderId, lineId) {
            const r = await tx.workOrderLine.deleteMany({ where: { id: lineId, sourceItemId: null, workOrder: { id: orderId, jobId } } });
            return r.count === 1;
          },
          async setStatus(orderId, status, actorId, at) {
            await tx.workOrder.updateMany({
              where: { id: orderId, jobId },
              data: status === "issued" ? { status, issuedAt: at, issuedBy: actorId } : { status, issuedAt: null, issuedBy: null },
            });
          },
        };
        return fn(handle);
      }, { timeout: 20_000 });
    },
  };
}
