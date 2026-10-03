// One-off tool: create commission ledger entries for payments recorded before commissions existed.
// Safe to re-run (it only adds entries for payments that have none). Skips voided payments and
// jobs with no estimator or no known margin.
//
//   node --env-file=.env --experimental-strip-types scripts/backfill-commission.ts
//
import { getDb } from "../src/lib/db.ts";
import { buildAccrual } from "../src/lib/commission/logic.ts";
import { localDate } from "../src/lib/commission/periods.ts";

const db = getDb();
const payments = await db.payment.findMany({
  where: { voidedAt: null },
  include: { job: true },
  orderBy: { receivedAt: "asc" },
});

let created = 0, skippedNoEstimator = 0, skippedNoMargin = 0, alreadyThere = 0;
for (const p of payments) {
  const exists = await db.commissionEntry.count({ where: { paymentId: p.id, kind: "earned" } });
  if (exists) { alreadyThere++; continue; }
  if (!p.job.estimatorId) { skippedNoEstimator++; continue; }
  const est = await db.user.findUnique({ where: { id: p.job.estimatorId } });
  const entry = buildAccrual(
    {
      id: p.job.id, estimatorId: p.job.estimatorId, estimatorOwnTruck: est?.ownTruck ?? false,
      contractCents: p.job.contractCents === null ? null : Number(p.job.contractCents),
      costCents: p.job.costCents === null ? null : Number(p.job.costCents),
    },
    { id: p.id, amountCents: Number(p.amountCents) },
    localDate(p.receivedAt),
  );
  if (!entry) { skippedNoMargin++; continue; }
  await db.commissionEntry.create({
    data: {
      estimatorId: entry.estimatorId, jobId: entry.jobId, paymentId: entry.paymentId, kind: "earned", rateBps: entry.rateBps,
      marginBps: entry.marginBps, amountCents: BigInt(entry.amountCents), entryDate: new Date(`${entry.entryDate}T00:00:00Z`),
    },
  });
  created++;
}
console.log(JSON.stringify({ payments: payments.length, created, alreadyThere, skippedNoEstimator, skippedNoMargin }));
await db.$disconnect();
