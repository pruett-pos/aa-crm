import type { PrismaClient } from "../../generated/prisma/client.ts";
import { toStored } from "../scopes/prisma-store.ts";
import type { Division, Stage } from "../rules.ts";
import type {
  JobStageOrClosed, ProductEntry, ProductionJob, ProductionStore, ProductionTx, ScheduleItem, TradePatch, TradeRow, TradeStatus,
} from "./types.ts";

const UUID = /^[0-9a-f-]{36}$/i;
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

type Client = Pick<PrismaClient, "job" | "user" | "document" | "payment" | "productionTrade" | "productionEvent" | "jobStageHistory" | "scope" | "scopeItem">;

type TradeDb = {
  jobId: string; division: string; status: string; installDate: Date | null; crewLeaderId: string | null;
  proposedBy: string | null; confirmedBy: string | null; startedAt: Date | null; completedAt: Date | null; notes: string | null;
};
const toTrade = (t: TradeDb, names: Map<string, string>): TradeRow => ({
  division: t.division as Division, status: t.status as TradeStatus, installDate: t.installDate ? dateStr(t.installDate) : null,
  crewLeaderId: t.crewLeaderId, crewLeaderName: t.crewLeaderId ? names.get(t.crewLeaderId) ?? null : null,
  proposedBy: t.proposedBy, confirmedBy: t.confirmedBy, startedAt: t.startedAt, completedAt: t.completedAt, notes: t.notes,
});

async function crewNames(c: Pick<PrismaClient, "user">, ids: (string | null)[]): Promise<Map<string, string>> {
  const real = [...new Set(ids.filter((x): x is string => !!x))];
  if (real.length === 0) return new Map();
  const us = await c.user.findMany({ where: { id: { in: real } }, select: { id: true, fullName: true } });
  return new Map(us.map((u) => [u.id, u.fullName]));
}

async function loadJob(c: Client, jobId: string): Promise<ProductionJob | null> {
  if (!UUID.test(jobId)) return null;
  const j = await c.job.findUnique({ where: { id: jobId }, include: { property: { include: { customer: true } } } });
  if (!j) return null;
  const [signed, deposits] = await Promise.all([
    c.document.count({ where: { jobId, kind: "contract", status: "signed" } }),
    c.payment.findMany({ where: { jobId, voidedAt: null, isDeposit: true }, select: { amountCents: true } }),
  ]);
  const cust = j.property.customer;
  return {
    id: j.id, jobNumber: j.jobNumber, stage: j.stage as JobStageOrClosed, estimatorId: j.estimatorId, divisions: j.divisions as Division[],
    customerName: `${cust.firstName} ${cust.lastName}`.trim(),
    propertyAddress: `${j.property.street}, ${j.property.city}, ${j.property.state} ${j.property.zip}`,
    contractSigned: signed > 0, depositRequiredCents: Number(j.depositRequiredCents),
    depositPaidCents: deposits.reduce((s, p) => s + Number(p.amountCents), 0),
    materialsOrderedAt: j.materialsOrderedAt, poReference: j.poReference,
  };
}

async function loadTrades(c: Client, jobId: string): Promise<TradeRow[]> {
  const rows = await c.productionTrade.findMany({ where: { jobId } });
  const names = await crewNames(c, rows.map((r) => r.crewLeaderId));
  return rows.map((r) => toTrade(r, names));
}

export function createPrismaProductionStore(db: PrismaClient): ProductionStore {
  async function toItems(rows: { jobId: string; division: string; status: string; installDate: Date | null; crewLeaderId: string | null }[]): Promise<ScheduleItem[]> {
    if (rows.length === 0) return [];
    const jobs = await db.job.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.jobId))] } }, include: { property: { include: { customer: true } } } });
    const names = await crewNames(db, rows.map((r) => r.crewLeaderId));
    return rows.flatMap((r) => {
      const j = jobs.find((x) => x.id === r.jobId);
      if (!j) return [];
      return [{
        jobId: j.id, jobNumber: j.jobNumber, division: r.division as Division, status: r.status as TradeStatus,
        installDate: r.installDate ? dateStr(r.installDate) : null, crewLeaderId: r.crewLeaderId,
        crewLeaderName: r.crewLeaderId ? names.get(r.crewLeaderId) ?? null : null,
        customerName: `${j.property.customer.firstName} ${j.property.customer.lastName}`.trim(),
        propertyAddress: `${j.property.street}, ${j.property.city}, ${j.property.state} ${j.property.zip}`, estimatorId: j.estimatorId,
      }];
    }).sort((a, b) => (a.installDate ?? "9999").localeCompare(b.installDate ?? "9999") || a.jobNumber - b.jobNumber);
  }

  return {
    getJob: (jobId) => loadJob(db, jobId),
    listTrades: (jobId) => (UUID.test(jobId) ? loadTrades(db, jobId) : Promise.resolve([])),

    async pmDivisions(userId) {
      if (!UUID.test(userId)) return [];
      const rows = await db.divisionManager.findMany({ where: { userId } });
      return [...new Set(rows.map((r) => r.division as Division))];
    },
    async listCrewLeaders() {
      const us = await db.user.findMany({ where: { role: "crew_leader", active: true }, orderBy: { fullName: "asc" } });
      return us.map((u) => ({ id: u.id, fullName: u.fullName }));
    },
    async isActiveCrewLeader(userId) {
      return UUID.test(userId) && (await db.user.count({ where: { id: userId, role: "crew_leader", active: true } })) > 0;
    },
    async getChosenScopes(jobId) {
      if (!UUID.test(jobId)) return [];
      const rows = await db.scope.findMany({ where: { jobId, selected: true }, include: { items: true } });
      return rows.map(toStored);
    },
    async listProducts(): Promise<ProductEntry[]> {
      const rows = await db.product.findMany();
      return rows.map((p) => ({ id: p.id, name: p.name, unit: p.unit, specialOrder: p.specialOrder }));
    },

    async listSchedule(range) {
      const rows = await db.productionTrade.findMany({
        where: { installDate: { gte: toDate(range.from), lte: toDate(range.to) }, status: { not: "not_scheduled" } },
      });
      return toItems(rows);
    },

    async listOpenTrades() {
      // Signed, open jobs that are still being scheduled: each trade with no row yet counts as "not scheduled".
      const jobs = await db.job.findMany({
        where: { stage: { in: ["contract_signed", "deposit_collected", "materials_ordered", "scheduled"] }, documents: { some: { kind: "contract", status: "signed" } } },
      });
      if (jobs.length === 0) return [];
      const rows = await db.productionTrade.findMany({ where: { jobId: { in: jobs.map((j) => j.id) } } });
      const synthetic = jobs.flatMap((j) => j.divisions.map((d) => {
        const r = rows.find((x) => x.jobId === j.id && x.division === d);
        return r ?? { jobId: j.id, division: d, status: "not_scheduled", installDate: null, crewLeaderId: null };
      }));
      return toItems(synthetic.filter((r) => r.status === "not_scheduled" || r.status === "proposed"));
    },

    async transaction(jobId, fn) {
      return db.$transaction(async (tx) => {
        // Lock the job so two scheduling actions on it run one at a time.
        if (UUID.test(jobId)) await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
        const handle: ProductionTx = {
          getJob: () => loadJob(tx, jobId),
          listTrades: () => loadTrades(tx, jobId),
          async upsertTrade(division, patch: TradePatch) {
            const data = {
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.installDate !== undefined ? { installDate: patch.installDate ? toDate(patch.installDate) : null } : {}),
              ...(patch.crewLeaderId !== undefined ? { crewLeaderId: patch.crewLeaderId } : {}),
              ...(patch.proposedBy !== undefined ? { proposedBy: patch.proposedBy } : {}),
              ...(patch.confirmedBy !== undefined ? { confirmedBy: patch.confirmedBy } : {}),
              ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
              ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
              ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
            };
            // Update or create explicitly instead of upsert: Postgres checks the table's CHECK rules on the row an
            // upsert would INSERT before it notices the row exists, so a partial create (just "started") would be rejected.
            const key = { jobId_division: { jobId, division } };
            const existing = await tx.productionTrade.findUnique({ where: key });
            if (existing) await tx.productionTrade.update({ where: key, data });
            else await tx.productionTrade.create({ data: { jobId, division, ...data } });
          },
          async logEvent(e) {
            await tx.productionEvent.create({ data: { jobId, division: e.division, actorId: e.actorId, action: e.action, detail: e.detail ?? null } });
          },
          async setStage(from, to: Stage, actorId) {
            await tx.job.update({ where: { id: jobId }, data: { stage: to } });
            await tx.jobStageHistory.create({ data: { jobId, fromStage: from as Stage, toStage: to, changedBy: actorId } });
          },
          async setMaterialsOrder(at, byUserId, poReference) {
            await tx.job.update({ where: { id: jobId }, data: { materialsOrderedAt: at, materialsOrderedBy: byUserId, poReference } });
          },
          async setJobInstallDate(date) {
            await tx.job.update({ where: { id: jobId }, data: { installDate: date ? toDate(date) : null } });
          },
          async chosenMaterialItemIds() {
            const rows = await tx.scopeItem.findMany({ where: { kind: "material", scope: { jobId, selected: true } }, select: { id: true } });
            return new Set(rows.map((r) => r.id));
          },
          async setColors(items) {
            for (const { itemId, color } of items) await tx.scopeItem.update({ where: { id: itemId }, data: { color } });
          },
          async crewConflicts(crewLeaderId, date, except) {
            const rows = await tx.productionTrade.findMany({
              where: { crewLeaderId, installDate: toDate(date), status: { in: ["scheduled", "in_production"] } },
            });
            const others = rows.filter((r) => !(r.jobId === except.jobId && r.division === except.division));
            if (others.length === 0) return [];
            const jobs = await tx.job.findMany({ where: { id: { in: others.map((o) => o.jobId) } }, select: { id: true, jobNumber: true } });
            return others.map((o) => ({ jobNumber: jobs.find((j) => j.id === o.jobId)?.jobNumber ?? 0, division: o.division as Division }));
          },
        };
        return fn(handle);
      });
    },
  };
}
