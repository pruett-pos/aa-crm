// The truck setting changes the commission rate only for payments collected AFTER the change. Each ledger entry
// snapshots its own rate and amount when its payment is recorded, and a void reverses that entry at its own rate,
// so nothing already booked is ever recomputed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryPaymentStore } from "../src/lib/payments/memory-store.ts";
import { recordPayment, voidPayment, type RecordInput } from "../src/lib/payments/logic.ts";
import type { PaymentJob } from "../src/lib/payments/types.ts";
import { MemoryUserAdminStore } from "../src/lib/users/memory-store.ts";
import { changeUser } from "../src/lib/users/service.ts";
import { commissionRateBps } from "../src/lib/rules.ts";

// 1,044,000 contract at 626,400 cost = 40% margin: company truck pays 8% (800 bps), own truck 10% (1000 bps).
const job = (): PaymentJob => ({
  id: "j1", jobNumber: 1, jobType: "retail", stage: "contract_signed", estimatorId: "est1", estimatorOwnTruck: false,
  contractCents: 1_044_000, costCents: 626_400, depositRequiredCents: 0,
});
const pay = (amountText: string): RecordInput => ({ jobId: "j1", recorder: { id: "est1", role: "estimator" }, amountText, type: "payment", method: "check", reference: "1", photo: { data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(1)]) } });
const at = (ms: number) => () => new Date(Date.UTC(2026, 10, 11, 12, 0, 0) + ms);

function world() {
  const users = new MemoryUserAdminStore();
  const admin = users.seed({ fullName: "AL", email: "al@x.com", role: "admin" });
  const est = users.seed({ fullName: "Est", email: "est@x.com", role: "estimator" });
  const actor = { id: admin.id, fullName: "AL", email: "al@x.com", role: "admin" as const, active: true };
  const payments = new MemoryPaymentStore();
  payments.jobs.push(job());
  // The real store reads users.own_truck when a payment is recorded (src/lib/payments/prisma-store.ts loadJob).
  const syncFlag = () => { payments.jobs[0].estimatorOwnTruck = users.users.find((u) => u.id === est.id)!.ownTruck; };
  return { users, est, actor, payments, syncFlag };
}

test("the rates are 8% company truck and 10% own truck at 40% margin", () => {
  assert.equal(commissionRateBps(4000, false), 800);
  assert.equal(commissionRateBps(4000, true), 1000);
});

test("a switch applies only to payments collected afterwards; earlier entries are not recomputed", async () => {
  const w = world();
  {
    w.syncFlag();
    await recordPayment(w.payments, pay("2,000"), at(0));            // company truck: 8% of 2,000 = 160.00
    await changeUser(w.users, w.actor, w.est.id, { ownTruck: true });
    w.syncFlag();
    await recordPayment(w.payments, pay("3,000"), at(120_000));      // own truck: 10% of 3,000 = 300.00
    await changeUser(w.users, w.actor, w.est.id, { ownTruck: false });
    w.syncFlag();
    await recordPayment(w.payments, pay("1,000"), at(240_000));      // company truck again: 80.00
  }
  const entries = w.payments.commission;
  assert.deepEqual(entries.map((e) => [e.rateBps, e.amountCents]), [[800, 16_000], [1000, 30_000], [800, 8_000]]);
  assert.equal(await w.payments.ledgerEarnedCents("j1"), 54_000);
});

test("voiding a payment collected before a switch reverses it at its ORIGINAL rate", async () => {
  const w = world();
  w.syncFlag();
  const first = await recordPayment(w.payments, pay("2,000"), at(0));          // 8%: 160.00
  await changeUser(w.users, w.actor, w.est.id, { ownTruck: true });
  w.syncFlag();
  await recordPayment(w.payments, pay("3,000"), at(120_000));                  // 10%: 300.00
  await voidPayment(w.payments, { paymentId: first.payment.id, userId: "admin1", reason: "bounced check" }, at(300_000));
  const reversal = w.payments.commission.find((e) => e.kind === "reversal")!;
  assert.deepEqual([reversal.rateBps, reversal.amountCents], [800, -16_000], "not -20.00 (the new 10% rate)");
  assert.equal(await w.payments.ledgerEarnedCents("j1"), 30_000);
});

test("the earned-so-far figure comes from the ledger, so a switch never rewrites it", async () => {
  const w = world();
  w.syncFlag();
  await recordPayment(w.payments, pay("2,000"), at(0));                        // 160.00 booked at 8%
  await changeUser(w.users, w.actor, w.est.id, { ownTruck: true });
  w.syncFlag();
  // Recomputing from the current flag would now say 200.00 for the same 2,000; the ledger still says 160.00.
  assert.equal(await w.payments.ledgerEarnedCents("j1"), 16_000);
});
