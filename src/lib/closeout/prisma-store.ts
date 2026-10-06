import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { Division, Stage } from "../rules.ts";
import type { JobStageOrClosed, TradeStatus } from "../production/types.ts";
import type {
  CloseoutJob, CloseoutStore, CloseoutTrade, CloseoutTx, InvoiceRow, InvoiceStatus, PunchItem,
} from "./types.ts";

const UUID = /^[0-9a-f-]{36}$/i;
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

type Client = Pick<PrismaClient, "job" | "document" | "productionTrade" | "punchlistItem" | "invoice" | "payment" | "scope" | "jobStageHistory">;

// Everything except the PDF bytes, so listing invoices never loads documents.
const INVOICE_SELECT = {
  id: true, jobId: true, invoiceNumber: true, issuedAt: true, dueOn: true, contractCents: true, paidCents: true, balanceCents: true,
  status: true, issuedBy: true, emailedTo: true, emailedAt: true, emailStatus: true, emailError: true, voidedAt: true, voidReason: true,
} as const;

type InvoiceDb = {
  id: string; jobId: string; invoiceNumber: number; issuedAt: Date; dueOn: Date; contractCents: bigint; paidCents: bigint; balanceCents: bigint;
  status: string; issuedBy: string | null; emailedTo: string | null; emailedAt: Date | null; emailStatus: string | null; emailError: string | null;
  voidedAt: Date | null; voidReason: string | null;
};
const toInvoice = (r: InvoiceDb): InvoiceRow => ({
  id: r.id, jobId: r.jobId, invoiceNumber: r.invoiceNumber, issuedAt: r.issuedAt, dueOn: dateStr(r.dueOn),
  contractCents: Number(r.contractCents), paidCents: Number(r.paidCents), balanceCents: Number(r.balanceCents),
  status: r.status as InvoiceStatus, issuedBy: r.issuedBy, emailedTo: r.emailedTo, emailedAt: r.emailedAt,
  emailStatus: r.emailStatus as "sent" | "failed" | null, emailError: r.emailError, voidedAt: r.voidedAt, voidReason: r.voidReason,
});

type ItemDb = { id: string; division: string | null; labelEn: string; labelRu: string | null; sortOrder: number; done: boolean; doneBy: string | null; doneAt: Date | null };
const toItem = (r: ItemDb): PunchItem => ({
  id: r.id, division: r.division as Division | null, labelEn: r.labelEn, labelRu: r.labelRu, sortOrder: r.sortOrder,
  done: r.done, doneBy: r.doneBy, doneAt: r.doneAt,
});

async function loadJob(c: Client, jobId: string): Promise<CloseoutJob | null> {
  if (!UUID.test(jobId)) return null;
  const j = await c.job.findUnique({ where: { id: jobId }, include: { property: { include: { customer: true } } } });
  if (!j) return null;
  const signed = await c.document.count({ where: { jobId, kind: "contract", status: "signed" } });
  const cust = j.property.customer;
  return {
    id: j.id, jobNumber: j.jobNumber, jobType: j.jobType, stage: j.stage as JobStageOrClosed, estimatorId: j.estimatorId,
    divisions: j.divisions as Division[], customerName: `${cust.firstName} ${cust.lastName}`.trim(), customerEmail: cust.email?.trim() || null,
    propertyAddress: `${j.property.street}, ${j.property.city}, ${j.property.state} ${j.property.zip}`,
    contractCents: j.contractCents === null ? null : Number(j.contractCents), contractSigned: signed > 0,
  };
}

async function loadTrades(c: Client, jobId: string): Promise<CloseoutTrade[]> {
  const rows = await c.productionTrade.findMany({ where: { jobId } });
  return rows.map((r) => ({ division: r.division as Division, status: r.status as TradeStatus, crewLeaderId: r.crewLeaderId }));
}

async function loadItems(c: Client, jobId: string): Promise<PunchItem[]> {
  const rows = await c.punchlistItem.findMany({ where: { jobId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  return rows.map(toItem);
}

async function collected(c: Client, jobId: string): Promise<number> {
  const r = await c.payment.aggregate({ where: { jobId, voidedAt: null }, _sum: { amountCents: true } });
  return Number(r._sum.amountCents ?? 0n);
}

export function createPrismaCloseoutStore(db: PrismaClient): CloseoutStore {
  return {
    getJob: (jobId) => loadJob(db, jobId),
    listTrades: (jobId) => (UUID.test(jobId) ? loadTrades(db, jobId) : Promise.resolve([])),
    async pmDivisions(userId) {
      if (!UUID.test(userId)) return [];
      const rows = await db.divisionManager.findMany({ where: { userId } });
      return [...new Set(rows.map((r) => r.division as Division))];
    },
    listItems: (jobId) => (UUID.test(jobId) ? loadItems(db, jobId) : Promise.resolve([])),
    async listInvoices(jobId) {
      if (!UUID.test(jobId)) return [];
      const rows = await db.invoice.findMany({ where: { jobId }, select: INVOICE_SELECT, orderBy: { invoiceNumber: "asc" } });
      return rows.map(toInvoice);
    },
    collectedCents: (jobId) => (UUID.test(jobId) ? collected(db, jobId) : Promise.resolve(0)),
    async getInvoice(id) {
      if (!UUID.test(id)) return null;
      const r = await db.invoice.findUnique({ where: { id }, select: INVOICE_SELECT });
      return r ? toInvoice(r) : null;
    },
    async getInvoicePdf(id) {
      if (!UUID.test(id)) return null;
      const r = await db.invoice.findUnique({ where: { id }, select: { pdfData: true } });
      return r ? new Uint8Array(r.pdfData) : null;
    },
    async recordEmail(id, e) {
      await db.invoice.update({
        where: { id },
        data: { emailedTo: e.to, emailStatus: e.status, emailError: e.error, ...(e.status === "sent" ? { emailedAt: e.at } : {}) },
      });
    },

    async transaction(jobId, fn) {
      return db.$transaction(async (tx) => {
        // Lock the job so two people issuing or editing at once run one at a time.
        if (UUID.test(jobId)) await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
        const handle: CloseoutTx = {
          getJob: () => loadJob(tx, jobId),
          listTrades: () => loadTrades(tx, jobId),
          listItems: () => loadItems(tx, jobId),
          async insertItems(items, actorId) {
            const last = await tx.punchlistItem.aggregate({ where: { jobId }, _max: { sortOrder: true } });
            let order = last._max.sortOrder ?? 0;
            for (const it of items) {
              await tx.punchlistItem.create({
                data: { jobId, division: it.division, labelEn: it.labelEn, labelRu: it.labelRu, sortOrder: ++order, createdBy: actorId },
              });
            }
          },
          async updateItem(id, patch, actorId, at) {
            const data = {
              ...(patch.labelEn !== undefined ? { labelEn: patch.labelEn } : {}),
              ...(patch.labelRu !== undefined ? { labelRu: patch.labelRu } : {}),
              ...(patch.done === undefined ? {} : patch.done ? { done: true, doneBy: actorId, doneAt: at } : { done: false, doneBy: null, doneAt: null }),
            };
            const res = await tx.punchlistItem.updateMany({ where: { id, jobId }, data });
            return res.count === 1;
          },
          async deleteItem(id) {
            const res = await tx.punchlistItem.deleteMany({ where: { id, jobId } });
            return res.count === 1;
          },
          collectedCents: () => collected(tx, jobId),
          async chosenSections() {
            const rows = await tx.scope.findMany({ where: { jobId, selected: true } });
            return rows.map((r) => ({ division: r.division as Division, packageTitle: r.title, subtotalCents: Number(r.saleCents) }));
          },
          async liveInvoice() {
            const r = await tx.invoice.findFirst({ where: { jobId, status: "issued" }, select: INVOICE_SELECT });
            return r ? toInvoice(r) : null;
          },
          async nextInvoiceNumber() {
            const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('invoice_number_seq') AS n`;
            return Number(rows[0].n);
          },
          async insertInvoice(i) {
            const row = await tx.invoice.create({
              data: {
                jobId, invoiceNumber: i.invoiceNumber, issuedAt: i.issuedAt, dueOn: new Date(`${i.dueOn}T00:00:00Z`),
                contractCents: BigInt(i.contractCents), paidCents: BigInt(i.paidCents), balanceCents: BigInt(i.balanceCents),
                issuedBy: i.issuedBy, pdfData: Buffer.from(i.pdf) as unknown as Uint8Array<ArrayBuffer>, pdfSha256: i.pdfSha256,
              },
              select: INVOICE_SELECT,
            });
            return toInvoice(row);
          },
          async voidInvoice(id, byUserId, reason, at) {
            const res = await tx.invoice.updateMany({
              where: { id, jobId, status: "issued" },
              data: { status: "void", voidedAt: at, voidedBy: byUserId, voidReason: reason },
            });
            return res.count === 1;
          },
          async setStage(from, to: Stage, actorId) {
            await tx.job.update({ where: { id: jobId }, data: { stage: to } });
            await tx.jobStageHistory.create({ data: { jobId, fromStage: from as Stage, toStage: to, changedBy: actorId } });
          },
        };
        return fn(handle);
      });
    },
  };
}
