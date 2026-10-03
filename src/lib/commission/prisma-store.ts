import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { Cadence, Schedule } from "./periods.ts";
import type { CommissionStore, CommissionTx, Draw, EntryKind, LedgerEntry, Run } from "./types.ts";

const UUID = /^[0-9a-f-]{36}$/i;
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

type EntryRow = {
  id: string; estimatorId: string; jobId: string | null; paymentId: string | null; kind: string; rateBps: number | null;
  marginBps: number | null; amountCents: bigint; entryDate: Date; runId: string | null; paidOn: Date | null; note: string | null;
};
const toEntry = (r: EntryRow, jobNumber: number | null = null): LedgerEntry => ({
  id: r.id, estimatorId: r.estimatorId, jobId: r.jobId, jobNumber, paymentId: r.paymentId, kind: r.kind as EntryKind,
  rateBps: r.rateBps, marginBps: r.marginBps, amountCents: Number(r.amountCents), entryDate: dateStr(r.entryDate),
  runId: r.runId, paidOn: r.paidOn ? dateStr(r.paidOn) : null, note: r.note,
});
type DrawRow = { id: string; estimatorId: string; amountCents: bigint; paidOn: Date; appliedCents: bigint; note: string | null };
const toDraw = (d: DrawRow): Draw => ({
  id: d.id, estimatorId: d.estimatorId, amountCents: Number(d.amountCents), paidOn: dateStr(d.paidOn),
  appliedCents: Number(d.appliedCents), note: d.note,
});
type RunRow = {
  id: string; estimatorId: string; periodStart: Date; periodEnd: Date; grossCents: bigint; drawsAppliedCents: bigint;
  netCents: bigint; paidOn: Date; note: string | null;
};
const toRun = (r: RunRow): Run => ({
  id: r.id, estimatorId: r.estimatorId, periodStart: dateStr(r.periodStart), periodEnd: dateStr(r.periodEnd),
  grossCents: Number(r.grossCents), drawsAppliedCents: Number(r.drawsAppliedCents), netCents: Number(r.netCents),
  paidOn: dateStr(r.paidOn), note: r.note,
});

export function createPrismaCommissionStore(db: PrismaClient): CommissionStore {
  return {
    async getSchedule() {
      const s = await db.commissionSettings.findUnique({ where: { id: 1 } });
      return s ? { cadence: s.cadence as Cadence, anchorDate: s.anchorDate ? dateStr(s.anchorDate) : null } : null;
    },
    async setSchedule(s: Schedule, userId) {
      const data = { cadence: s.cadence, anchorDate: s.anchorDate ? toDate(s.anchorDate) : null, updatedBy: userId, updatedAt: new Date() };
      await db.commissionSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    },
    async getEstimator(id) {
      if (!UUID.test(id)) return null;
      const u = await db.user.findFirst({ where: { id, role: "estimator" } });
      return u ? { id: u.id, fullName: u.fullName, ownTruck: u.ownTruck, active: u.active } : null;
    },
    async listEstimators() {
      const us = await db.user.findMany({ where: { role: "estimator" }, orderBy: { fullName: "asc" } });
      return us.map((u) => ({ id: u.id, fullName: u.fullName, ownTruck: u.ownTruck, active: u.active }));
    },
    async listEntries(estimatorId, limit) {
      const rows = await db.commissionEntry.findMany({ where: { estimatorId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit });
      const ids = [...new Set(rows.map((r) => r.jobId).filter((x): x is string => !!x))];
      const jobs = ids.length ? await db.job.findMany({ where: { id: { in: ids } }, select: { id: true, jobNumber: true } }) : [];
      return rows.map((r) => toEntry(r, jobs.find((j) => j.id === r.jobId)?.jobNumber ?? null));
    },
    async listDraws(estimatorId) {
      return (await db.commissionDraw.findMany({ where: { estimatorId }, orderBy: [{ paidOn: "asc" }, { createdAt: "asc" }] })).map(toDraw);
    },
    async listRuns(estimatorId) {
      return (await db.commissionRun.findMany({ where: { estimatorId }, orderBy: { periodEnd: "desc" } })).map(toRun);
    },
    async unpaidThrough(estimatorId, throughDate) {
      const r = await db.commissionEntry.aggregate({
        where: { estimatorId, runId: null, entryDate: { lte: toDate(throughDate) } }, _sum: { amountCents: true },
      });
      return Number(r._sum.amountCents ?? 0);
    },
    async uncommissionedPaymentCount() {
      const rows = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM payments p JOIN jobs j ON j.id = p.job_id
        WHERE p.voided_at IS NULL AND j.estimator_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM commission_payouts c WHERE c.payment_id = p.id AND c.kind = 'earned')`;
      return Number(rows[0]?.n ?? 0);
    },

    async transaction(estimatorId, fn) {
      return db.$transaction(async (tx) => {
        // Lock this estimator so two payouts (or a payout and a draw) run one at a time.
        if (UUID.test(estimatorId)) await tx.$queryRaw`SELECT id FROM users WHERE id = ${estimatorId}::uuid FOR UPDATE`;
        const handle: CommissionTx = {
          async hasRun(periodEnd) {
            return (await tx.commissionRun.count({ where: { estimatorId, periodEnd: toDate(periodEnd) } })) > 0;
          },
          async unpaidEntries(throughDate) {
            const rows = await tx.commissionEntry.findMany({
              where: { estimatorId, runId: null, entryDate: { lte: toDate(throughDate) } }, orderBy: { createdAt: "asc" },
            });
            return rows.map((r) => toEntry(r));
          },
          async outstandingDraws() {
            const rows = await tx.commissionDraw.findMany({ where: { estimatorId }, orderBy: [{ paidOn: "asc" }, { createdAt: "asc" }] });
            return rows.filter((d) => d.amountCents > d.appliedCents).map(toDraw);
          },
          async createRun(r, entryIds, applications, createdBy) {
            const run = await tx.commissionRun.create({
              data: {
                estimatorId: r.estimatorId, periodStart: toDate(r.periodStart), periodEnd: toDate(r.periodEnd),
                grossCents: BigInt(r.grossCents), drawsAppliedCents: BigInt(r.drawsAppliedCents), netCents: BigInt(r.netCents),
                paidOn: toDate(r.paidOn), note: r.note, createdBy,
              },
            });
            // Only still-unpaid entries may be claimed; a mismatch means someone else paid them first.
            const claimed = await tx.commissionEntry.updateMany({
              where: { id: { in: entryIds }, runId: null }, data: { runId: run.id, paidOn: toDate(r.paidOn) },
            });
            if (claimed.count !== entryIds.length) throw new Error("Commission entries changed while paying; try again");
            for (const a of applications) {
              await tx.commissionDraw.update({ where: { id: a.drawId }, data: { appliedCents: { increment: BigInt(a.amountCents) } } });
              await tx.commissionDrawApplication.create({ data: { runId: run.id, drawId: a.drawId, amountCents: BigInt(a.amountCents) } });
            }
            return toRun(run);
          },
          async insertDraw(d, createdBy) {
            return toDraw(await tx.commissionDraw.create({
              data: { estimatorId: d.estimatorId, amountCents: BigInt(d.amountCents), paidOn: toDate(d.paidOn), note: d.note, createdBy },
            }));
          },
          async insertAdjustment(e, createdBy) {
            return toEntry(await tx.commissionEntry.create({
              data: {
                estimatorId: e.estimatorId, kind: "adjustment", amountCents: BigInt(e.amountCents),
                entryDate: toDate(e.entryDate), note: e.note, createdBy,
              },
            }));
          },
        };
        return fn(handle);
      });
    },
  };
}
