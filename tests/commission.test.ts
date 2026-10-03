import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CommissionError, addAdjustment, buildAccrual, canAdjust, canManagePayouts, canSetSchedule, canViewStatement,
  payoutOverview, recordDraw, runPayout, setSchedule, statement,
} from "../src/lib/commission/logic.ts";
import { MemoryCommissionStore } from "../src/lib/commission/memory-store.ts";
import { recordPayment, voidPayment } from "../src/lib/payments/logic.ts";
import { MemoryPaymentStore } from "../src/lib/payments/memory-store.ts";
import type { PaymentJob } from "../src/lib/payments/types.ts";

const now = () => new Date("2026-10-14T17:00:00Z"); // Wednesday Oct 14, noon Central
const code = (p: Promise<unknown>) => p.then(() => "no error", (e: CommissionError) => e.code);

function setup(withSchedule = true) {
  const s = new MemoryCommissionStore();
  s.estimators = [
    { id: "est1", fullName: "Estimator One", ownTruck: true, active: true },
    { id: "est2", fullName: "Estimator Two", ownTruck: false, active: true },
  ];
  if (withSchedule) s.schedule = { cadence: "weekly", anchorDate: "2026-10-09" }; // periods end on Fridays
  return s;
}

// ---------- accrual through the payments transaction ----------
const job = (over: Partial<PaymentJob> = {}): PaymentJob => ({
  id: "j1", jobNumber: 1, jobType: "retail", stage: "contract_signed", estimatorId: "est1", estimatorOwnTruck: true,
  contractCents: 1_044_000, costCents: 626_400, depositRequiredCents: 522_000, ...over, // 40% margin
});
function payments(j: Partial<PaymentJob> = {}) {
  const s = new MemoryPaymentStore();
  s.jobs.push(job(j));
  return s;
}
const pay = { jobId: "j1", recorder: { id: "acct", role: "accounting" as const }, type: "payment" as const, method: "cash" };

test("accrual: 10% for an own-truck estimator at 40% margin, snapshotting rate and margin", async () => {
  const s = payments();
  await recordPayment(s, { ...pay, amountText: "5,220" }, now);
  assert.equal(s.commission.length, 1);
  assert.deepEqual(
    { kind: s.commission[0].kind, rate: s.commission[0].rateBps, margin: s.commission[0].marginBps, amount: s.commission[0].amountCents, date: s.commission[0].entryDate },
    { kind: "earned", rate: 1000, margin: 4000, amount: 52_200, date: "2026-10-14" },
  );
});

test("accrual: 7% at 38% margin without a truck; 8% at 39% (full 2-point steps)", async () => {
  const a = payments({ estimatorOwnTruck: false, costCents: 647_280 }); // 1,044,000 sale -> 38.0% margin
  await recordPayment(a, { ...pay, amountText: "1,000" }, now);
  assert.equal(a.commission[0].rateBps, 700);
  assert.equal(a.commission[0].amountCents, 7_000);
  const b = payments({ estimatorOwnTruck: false, costCents: 636_840 }); // 39.0%
  await recordPayment(b, { ...pay, amountText: "1,000" }, now);
  assert.equal(b.commission[0].rateBps, 800);
});

test("accrual: collected amount, not sold amount; each payment gets its own entry", async () => {
  const s = payments();
  await recordPayment(s, { ...pay, amountText: "2,000" }, now);
  await recordPayment(s, { ...pay, amountText: "3,000" }, () => new Date("2026-10-15T17:00:00Z"));
  assert.deepEqual(s.commission.map((c) => c.amountCents), [20_000, 30_000]);
});

test("accrual: no estimator or unknown margin means no entry", () => {
  const p = { id: "p1", amountCents: 100_000 };
  assert.equal(buildAccrual({ ...job(), estimatorId: null }, p, "2026-10-14"), null);
  assert.equal(buildAccrual({ ...job(), costCents: null }, p, "2026-10-14"), null);
  assert.equal(buildAccrual({ ...job(), contractCents: null }, p, "2026-10-14"), null);
});

test("accrual uses the Central date: 10 pm Central on Oct 14 is Oct 15 in UTC but still Oct 14 here", async () => {
  const s = payments();
  await recordPayment(s, { ...pay, amountText: "100" }, () => new Date("2026-10-15T03:00:00Z"));
  assert.equal(s.commission[0].entryDate, "2026-10-14");
});

test("void: adds one reversal dated the void day; the original entry stays", async () => {
  const s = payments();
  const { payment } = await recordPayment(s, { ...pay, amountText: "5,220" }, now);
  await voidPayment(s, { paymentId: payment.id, userId: "acct", reason: "bounced" }, () => new Date("2026-10-20T17:00:00Z"));
  assert.deepEqual(s.commission.map((c) => [c.kind, c.amountCents, c.entryDate]), [
    ["earned", 52_200, "2026-10-14"], ["reversal", -52_200, "2026-10-20"],
  ]);
  assert.equal(s.commission.reduce((t, c) => t + c.amountCents, 0), 0);
});

test("void: a payment with no commission entry creates no reversal", async () => {
  const s = payments({ estimatorId: null });
  const { payment } = await recordPayment(s, { ...pay, amountText: "100" }, now);
  await voidPayment(s, { paymentId: payment.id, userId: "acct", reason: "typo" }, now);
  assert.equal(s.commission.length, 0);
});

// ---------- schedule ----------
test("schedule: weekly needs an anchor; monthly drops it; bad values refused", async () => {
  const s = setup(false);
  assert.equal(await code(setSchedule(s, { cadence: "weekly", anchorDate: null, userId: "a" })), "schedule_invalid");
  assert.equal(await code(setSchedule(s, { cadence: "weekly", anchorDate: "2026-02-30", userId: "a" })), "schedule_invalid");
  assert.equal(await code(setSchedule(s, { cadence: "daily", anchorDate: null, userId: "a" })), "schedule_invalid");
  assert.deepEqual(await setSchedule(s, { cadence: "monthly", anchorDate: "2026-10-09", userId: "a" }), { cadence: "monthly", anchorDate: null });
  assert.deepEqual(await setSchedule(s, { cadence: "biweekly", anchorDate: "2026-10-09", userId: "a" }), { cadence: "biweekly", anchorDate: "2026-10-09" });
  assert.deepEqual(s.schedule, { cadence: "biweekly", anchorDate: "2026-10-09" });
});

// ---------- draws and adjustments ----------
test("draw: validates estimator, amount and date", async () => {
  const s = setup();
  const d = await recordDraw(s, { actorId: "acct", estimatorId: "est1", amountText: "1,500", note: " advance " }, now);
  assert.deepEqual([d.amountCents, d.paidOn, d.appliedCents, d.note], [150_000, "2026-10-14", 0, "advance"]);
  assert.equal(await code(recordDraw(s, { actorId: "a", estimatorId: "nobody", amountText: "10" }, now)), "estimator_invalid");
  assert.equal(await code(recordDraw(s, { actorId: "a", estimatorId: "est1", amountText: "0" }, now)), "amount_invalid");
  assert.equal(await code(recordDraw(s, { actorId: "a", estimatorId: "est1", amountText: "-5" }, now)), "amount_invalid");
  assert.equal(await code(recordDraw(s, { actorId: "a", estimatorId: "est1", amountText: "10", paidOn: "2026-10-20" }, now)), "date_invalid");
  assert.equal(await code(recordDraw(s, { actorId: "a", estimatorId: "est1", amountText: "10", paidOn: "2024-01-01" }, now)), "date_invalid");
  assert.equal(await code(recordDraw(s, { actorId: "a", estimatorId: "est1", amountText: "10", paidOn: "nope" }, now)), "date_invalid");
});

test("adjustment: signed amount, reason required, shows up unpaid", async () => {
  const s = setup();
  const up = await addAdjustment(s, { actorId: "adm", estimatorId: "est1", amountText: "250", reason: "Bonus for referral" }, now);
  const down = await addAdjustment(s, { actorId: "adm", estimatorId: "est1", amountText: "-75.50", reason: "Correct a miskeyed margin" }, now);
  assert.deepEqual([up.amountCents, down.amountCents, down.kind, down.runId], [25_000, -7_550, "adjustment", null]);
  assert.equal(await code(addAdjustment(s, { actorId: "adm", estimatorId: "est1", amountText: "10", reason: " " }, now)), "reason_required");
  assert.equal(await code(addAdjustment(s, { actorId: "adm", estimatorId: "est1", amountText: "x", reason: "valid reason" }, now)), "amount_invalid");
  assert.equal(await s.unpaidThrough("est1", "2026-10-14"), 17_450);
});

// ---------- payout runs ----------
test("payout: pays everything earned through the period end, not later entries", async () => {
  const s = setup();
  s.addEarned("est1", 40_000, "2026-10-04");
  s.addEarned("est1", 60_000, "2026-10-09");  // last day of the period counts
  s.addEarned("est1", 99_999, "2026-10-10");  // next period
  const r = await runPayout(s, { actorId: "acct", estimatorId: "est1", periodEnd: "2026-10-09" }, now);
  assert.deepEqual(
    [r.run.periodStart, r.run.periodEnd, r.run.grossCents, r.run.drawsAppliedCents, r.run.netCents, r.run.paidOn, r.entriesPaid],
    ["2026-10-03", "2026-10-09", 100_000, 0, 100_000, "2026-10-14", 2],
  );
  assert.equal(await s.unpaidThrough("est1", "2026-12-31"), 99_999); // the later entry is still unpaid
});

test("payout: draws are netted first-in-first-out; a partly used draw keeps its remainder", async () => {
  const s = setup();
  s.addEarned("est1", 100_000, "2026-10-05");
  s.draws.push(
    { id: "d1", estimatorId: "est1", amountCents: 30_000, paidOn: "2026-09-20", appliedCents: 0, note: null },
    { id: "d2", estimatorId: "est1", amountCents: 100_000, paidOn: "2026-09-27", appliedCents: 0, note: null },
  );
  const r = await runPayout(s, { actorId: "acct", estimatorId: "est1", periodEnd: "2026-10-09" }, now);
  assert.deepEqual([r.run.grossCents, r.run.drawsAppliedCents, r.run.netCents], [100_000, 100_000, 0]);
  assert.deepEqual(s.draws.map((d) => d.appliedCents), [30_000, 70_000]);          // oldest used fully first
  assert.equal(s.draws[1].amountCents - s.draws[1].appliedCents, 30_000);          // remainder stays owed
  assert.equal(s.applications.reduce((t, a) => t + a.amountCents, 0), 100_000);
});

test("payout: a draw smaller than earnings is absorbed and the rest is paid", async () => {
  const s = setup();
  s.addEarned("est1", 100_000, "2026-10-05");
  s.draws.push({ id: "d1", estimatorId: "est1", amountCents: 25_000, paidOn: "2026-09-20", appliedCents: 0, note: null });
  const r = await runPayout(s, { actorId: "acct", estimatorId: "est1", periodEnd: "2026-10-09" }, now);
  assert.deepEqual([r.run.drawsAppliedCents, r.run.netCents], [25_000, 75_000]);
});

test("payout: only one run per estimator per period; other estimators are unaffected", async () => {
  const s = setup();
  s.addEarned("est1", 50_000, "2026-10-05");
  s.addEarned("est2", 70_000, "2026-10-06");
  await runPayout(s, { actorId: "acct", estimatorId: "est1", periodEnd: "2026-10-09" }, now);
  assert.equal(await code(runPayout(s, { actorId: "acct", estimatorId: "est1", periodEnd: "2026-10-09" }, now)), "already_paid");
  const r2 = await runPayout(s, { actorId: "acct", estimatorId: "est2", periodEnd: "2026-10-09" }, now);
  assert.equal(r2.run.netCents, 70_000);
  assert.equal(s.runs.length, 2);
});

test("payout: refused for open periods, non-period dates, and before a schedule exists", async () => {
  const s = setup();
  s.addEarned("est1", 50_000, "2026-10-12");
  assert.equal(await code(runPayout(s, { actorId: "a", estimatorId: "est1", periodEnd: "2026-10-16" }, now)), "period_open");
  assert.equal(await code(runPayout(s, { actorId: "a", estimatorId: "est1", periodEnd: "2026-10-14" }, now)), "period_invalid");
  assert.equal(await code(runPayout(s, { actorId: "a", estimatorId: "est1", periodEnd: "garbage" }, now)), "period_invalid");
  assert.equal(await code(runPayout(s, { actorId: "a", estimatorId: "nobody", periodEnd: "2026-10-09" }, now)), "estimator_invalid");
  assert.equal(await code(runPayout(setup(false), { actorId: "a", estimatorId: "est1", periodEnd: "2026-10-09" }, now)), "no_schedule");
  // the last day of a period is still "open" until the day after
  assert.equal(await code(runPayout(s, { actorId: "a", estimatorId: "est1", periodEnd: "2026-10-09" }, () => new Date("2026-10-09T20:00:00Z"))), "period_open");
});

test("payout: nothing earned, or a net clawback, pays nothing and carries forward", async () => {
  const s = setup();
  assert.equal(await code(runPayout(s, { actorId: "a", estimatorId: "est1", periodEnd: "2026-10-09" }, now)), "nothing_to_pay");
  s.addEarned("est1", -30_000, "2026-10-06");
  assert.equal(await code(runPayout(s, { actorId: "a", estimatorId: "est1", periodEnd: "2026-10-09" }, now)), "nothing_to_pay");
  assert.equal(s.runs.length, 0);
  // the clawback nets against the next period's earnings
  s.addEarned("est1", 80_000, "2026-10-14");
  const r = await runPayout(s, { actorId: "a", estimatorId: "est1", periodEnd: "2026-10-16" }, () => new Date("2026-10-19T17:00:00Z"));
  assert.equal(r.run.grossCents, 50_000);
});

test("payout: unpaid earnings from earlier periods roll into the next payout", async () => {
  const s = setup();
  s.addEarned("est1", 10_000, "2026-09-30");        // earlier period, never paid
  s.addEarned("est1", 20_000, "2026-10-05");
  const r = await runPayout(s, { actorId: "a", estimatorId: "est1", periodEnd: "2026-10-09" }, now);
  assert.equal(r.run.grossCents, 30_000);
  assert.equal(r.entriesPaid, 2);
});

test("payout: a failure partway leaves nothing half-paid", async () => {
  const s = setup();
  s.addEarned("est1", 50_000, "2026-10-05");
  const real = s.transaction.bind(s);
  s.transaction = (async (id: string, fn: Parameters<typeof real>[1]) => real(id, async (tx) => {
    return fn({ ...tx, createRun: async (...a: Parameters<typeof tx.createRun>) => { await tx.createRun(...a); throw new Error("db hiccup"); } });
  })) as typeof s.transaction;
  await assert.rejects(() => runPayout(s, { actorId: "a", estimatorId: "est1", periodEnd: "2026-10-09" }, now), /db hiccup/);
  assert.equal(s.runs.length, 0);
  assert.equal(s.entries[0].runId, null);
});

// ---------- statements and overview ----------
test("statement: totals for the period, unpaid, draws and net if paid today", async () => {
  const s = setup();
  s.addEarned("est1", 40_000, "2026-10-05");                     // last period
  s.addEarned("est1", 25_000, "2026-10-12");                     // this period (Oct 10-16)
  s.draws.push({ id: "d1", estimatorId: "est1", amountCents: 20_000, paidOn: "2026-10-01", appliedCents: 5_000, note: null });
  const st = await statement(s, "est1", now);
  assert.deepEqual(st.currentPeriod, { start: "2026-10-10", end: "2026-10-16" });
  assert.deepEqual(
    [st.earnedThisPeriodCents, st.unpaidCents, st.drawsOutstandingCents, st.netIfPaidTodayCents],
    [25_000, 65_000, 15_000, 50_000],
  );
  assert.equal(await code(statement(s, "nobody", now)), "not_found");
});

test("overview: the latest closed period per estimator, with draws and net", async () => {
  const s = setup();
  s.addEarned("est1", 100_000, "2026-10-05");
  s.draws.push({ id: "d1", estimatorId: "est1", amountCents: 30_000, paidOn: "2026-09-20", appliedCents: 0, note: null });
  s.addEarned("est2", 20_000, "2026-10-12"); // open period only
  s.uncommissioned = 2;
  const o = await payoutOverview(s, now);
  const r1 = o.rows.find((r) => r.estimatorId === "est1")!;
  const r2 = o.rows.find((r) => r.estimatorId === "est2")!;
  assert.deepEqual(r1.period, { start: "2026-10-03", end: "2026-10-09" });
  assert.deepEqual([r1.unpaidThroughCents, r1.drawsOutstandingCents, r1.netCents, r1.canPay], [100_000, 30_000, 70_000, true]);
  assert.deepEqual([r2.unpaidThroughCents, r2.canPay], [0, false]);
  assert.equal(o.uncommissionedPayments, 2);
  await runPayout(s, { actorId: "a", estimatorId: "est1", periodEnd: "2026-10-09" }, now);
  assert.equal((await payoutOverview(s, now)).rows.find((r) => r.estimatorId === "est1")!.alreadyPaid, true);
  assert.equal((await payoutOverview(setup(false), now)).schedule, null);
});

test("roles: estimators see only their own statement; accounting pays; only admin adjusts and sets the schedule", () => {
  assert.ok(canViewStatement({ id: "est1", role: "estimator" }, "est1"));
  assert.ok(!canViewStatement({ id: "est2", role: "estimator" }, "est1"));
  assert.ok(canViewStatement({ id: "acct", role: "accounting" }, "est1"));
  assert.ok(canViewStatement({ id: "adm", role: "admin" }, "est1"));
  for (const role of ["production_manager", "csr", "crew_leader"] as const) assert.ok(!canViewStatement({ id: "x", role }, "est1"), role);
  assert.ok(canManagePayouts("accounting") && canManagePayouts("admin"));
  assert.ok(!canManagePayouts("estimator") && !canManagePayouts("csr"));
  assert.ok(canAdjust("admin") && !canAdjust("accounting"));
  assert.ok(canSetSchedule("admin") && !canSetSchedule("accounting"));
});
