import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { Stage } from "../rules.ts";
import type {
  JobStageOrClosed, Method, NewPayment, PaymentJob, PaymentRecord, PaymentStore, PaymentTx,
} from "./types.ts";

// Everything except the photo bytes, so listing payments never loads images.
const LIST_SELECT = {
  id: true, jobId: true, amountCents: true, method: true, isDeposit: true, isDepreciation: true,
  reference: true, notes: true, collectedBy: true, receivedAt: true, voidedAt: true, voidReason: true,
  checkPhotoMime: true,
} as const;

type Row = {
  id: string; jobId: string; amountCents: bigint; method: string; isDeposit: boolean; isDepreciation: boolean;
  reference: string | null; notes: string | null; collectedBy: string | null; receivedAt: Date;
  voidedAt: Date | null; voidReason: string | null; checkPhotoMime: string | null;
};

const toRecord = (r: Row): PaymentRecord => ({
  id: r.id, jobId: r.jobId, amountCents: Number(r.amountCents), method: r.method as Method,
  isDeposit: r.isDeposit, isDepreciation: r.isDepreciation, reference: r.reference, notes: r.notes,
  collectedBy: r.collectedBy, receivedAt: r.receivedAt, voidedAt: r.voidedAt, voidReason: r.voidReason,
  hasPhoto: r.checkPhotoMime !== null,
});

const UUID = /^[0-9a-f-]{36}$/i;

export function createPrismaPaymentStore(db: PrismaClient): PaymentStore {
  type Client = Pick<PrismaClient, "job" | "user" | "payment" | "jobStageHistory">;

  async function loadJob(c: Client, jobId: string): Promise<PaymentJob | null> {
    if (!UUID.test(jobId)) return null;
    const j = await c.job.findUnique({ where: { id: jobId } });
    if (!j) return null;
    const est = j.estimatorId ? await c.user.findUnique({ where: { id: j.estimatorId } }) : null;
    return {
      id: j.id, jobNumber: j.jobNumber, jobType: j.jobType, stage: j.stage as JobStageOrClosed,
      estimatorId: j.estimatorId, estimatorOwnTruck: est?.ownTruck ?? false,
      contractCents: j.contractCents === null ? null : Number(j.contractCents),
      costCents: j.costCents === null ? null : Number(j.costCents),
      depositRequiredCents: Number(j.depositRequiredCents),
    };
  }

  return {
    getPaymentJob: (jobId) => loadJob(db, jobId),

    async listPayments(jobId) {
      if (!UUID.test(jobId)) return [];
      const rows = await db.payment.findMany({ where: { jobId }, select: LIST_SELECT, orderBy: { receivedAt: "asc" } });
      return rows.map(toRecord);
    },

    async getPayment(id) {
      if (!UUID.test(id)) return null;
      const r = await db.payment.findUnique({ where: { id }, select: LIST_SELECT });
      return r ? toRecord(r) : null;
    },

    async getPhoto(id) {
      if (!UUID.test(id)) return null;
      const r = await db.payment.findUnique({ where: { id }, select: { checkPhotoData: true, checkPhotoMime: true } });
      return r?.checkPhotoData && r.checkPhotoMime ? { data: r.checkPhotoData, mime: r.checkPhotoMime } : null;
    },

    async transaction(jobId, fn) {
      return db.$transaction(async (tx) => {
        // Lock the job row so concurrent payments on one job run one at a time.
        if (UUID.test(jobId)) await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
        const handle: PaymentTx = {
          getJob: () => loadJob(tx, jobId),
          async list() {
            const rows = await tx.payment.findMany({ where: { jobId }, select: LIST_SELECT, orderBy: { receivedAt: "asc" } });
            return rows.map(toRecord);
          },
          async insert(p: NewPayment) {
            const row = await tx.payment.create({
              data: {
                jobId, amountCents: BigInt(p.amountCents), method: p.method, isDeposit: p.isDeposit,
                isDepreciation: p.isDepreciation, reference: p.reference, notes: p.notes, collectedBy: p.collectedBy,
                receivedAt: p.receivedAt,
                checkPhotoData: p.photo ? (Buffer.from(p.photo.data) as unknown as Uint8Array<ArrayBuffer>) : null,
                checkPhotoMime: p.photo?.mime ?? null,
              },
              select: LIST_SELECT,
            });
            if (p.photo) {
              await tx.payment.update({ where: { id: row.id }, data: { checkPhotoUrl: `/api/payments/${row.id}/photo` } });
            }
            return toRecord(row);
          },
          async setStage(from, to: Stage, userId) {
            await tx.job.update({ where: { id: jobId }, data: { stage: to } });
            await tx.jobStageHistory.create({ data: { jobId, fromStage: from as Stage, toStage: to, changedBy: userId } });
          },
          async insertCommission(e) {
            await tx.commissionEntry.create({
              data: {
                estimatorId: e.estimatorId, jobId: e.jobId, paymentId: e.paymentId, kind: e.kind, rateBps: e.rateBps,
                marginBps: e.marginBps, amountCents: BigInt(e.amountCents), entryDate: new Date(`${e.entryDate}T00:00:00Z`), note: e.note,
              },
            });
          },
          async reverseCommission(paymentId, entryDate) {
            const rows = await tx.commissionEntry.findMany({ where: { paymentId, kind: { in: ["earned", "reversal"] } } });
            const earned = rows.find((r) => r.kind === "earned");
            if (!earned || rows.some((r) => r.kind === "reversal")) return;
            await tx.commissionEntry.create({
              data: {
                estimatorId: earned.estimatorId, jobId: earned.jobId, paymentId, kind: "reversal", rateBps: earned.rateBps,
                marginBps: earned.marginBps, amountCents: -earned.amountCents, entryDate: new Date(`${entryDate}T00:00:00Z`),
              },
            });
          },
          async void(paymentId, userId, reason, at) {
            const res = await tx.payment.updateMany({
              where: { id: paymentId, jobId, voidedAt: null },
              data: { voidedAt: at, voidedBy: userId, voidReason: reason },
            });
            return res.count === 1;
          },
        };
        return fn(handle);
      });
    },
  };
}
