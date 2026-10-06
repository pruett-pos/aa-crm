import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PaymentError, canRecordPayments, canSeeCommissionEarned, canVoidPayments, commissionEarnedSoFar,
  recordPayment, sniffImageMime, summarize, voidPayment, type RecordInput,
} from "../src/lib/payments/logic.ts";
import { MemoryPaymentStore } from "../src/lib/payments/memory-store.ts";
import type { PaymentJob } from "../src/lib/payments/types.ts";
import type { AuthUser } from "../src/lib/auth/store.ts";
import type { Role } from "../src/lib/auth/roles.ts";

const user = (id: string, role: Role): AuthUser => ({ id, fullName: id, email: `${id}@x.com`, role, active: true });
const jpeg = () => ({ data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(1)]) });

const baseJob = (over: Partial<PaymentJob> = {}): PaymentJob => ({
  id: "j1", jobNumber: 1, jobType: "retail", stage: "contract_signed", estimatorId: "est1", estimatorOwnTruck: true,
  contractCents: 1_044_000, costCents: 626_400, depositRequiredCents: 522_000, ...over,
});
function setup(job: Partial<PaymentJob> = {}) {
  const store = new MemoryPaymentStore();
  store.jobs.push(baseJob(job));
  return store;
}
const input = (over: Partial<RecordInput> = {}): RecordInput => ({
  jobId: "j1", recorder: { id: "est1", role: "estimator" }, amountText: "2,000", type: "deposit", method: "check",
  reference: "1042", photo: jpeg(), ...over,
});
const code = (p: Promise<unknown>) => p.then(() => "no error", (e: PaymentError) => e.code);
const at = (ms: number) => () => new Date(Date.UTC(2026, 9, 5, 12, 0, 0) + ms);

test("record: partial deposit does not move the stage; completing it does", async () => {
  const store = setup();
  const first = await recordPayment(store, input(), at(0));
  assert.equal(first.payment.amountCents, 200_000);
  assert.equal(first.stageChanged, false);
  assert.equal(first.summary.depositDueCents, 322_000);
  assert.equal(store.jobs[0].stage, "contract_signed");

  const second = await recordPayment(store, input({ amountText: "3,220", method: "card", reference: "HELCIM-778", photo: null }), at(120_000));
  assert.equal(second.stageChanged, true);
  assert.equal(second.summary.depositDueCents, 0);
  assert.equal(second.summary.depositCovered, true);
  assert.equal(store.jobs[0].stage, "deposit_collected");
  assert.deepEqual(store.history.map((h) => [h.from, h.to]), [["contract_signed", "deposit_collected"]]);
});

test("record: a non-deposit payment never advances the stage", async () => {
  const store = setup();
  const r = await recordPayment(store, input({ amountText: "5,220", type: "payment" }), at(0));
  assert.equal(r.stageChanged, false);
  assert.equal(store.jobs[0].stage, "contract_signed");
});

test("record: no deposit required means no stage change", async () => {
  const store = setup({ depositRequiredCents: 0, contractCents: 400_000, costCents: 240_000 });
  const r = await recordPayment(store, input({ amountText: "1000", type: "payment" }), at(0));
  assert.equal(r.stageChanged, false);
  assert.equal(r.summary.collectedCents, 100_000);
});

test("record: overpaying the contract is refused, exact total is fine", async () => {
  const store = setup();
  assert.equal(await code(recordPayment(store, input({ amountText: "10,440.01", type: "payment" }))), "overpay");
  await recordPayment(store, input({ amountText: "10,440", type: "payment" }), at(0));
  assert.equal((await store.listPayments("j1")).length, 1);
  assert.equal(await code(recordPayment(store, input({ amountText: "0.01", type: "payment" }), at(200_000))), "overpay");
});

test("record: voided payments no longer count toward the overpay limit", async () => {
  const store = setup();
  const { payment } = await recordPayment(store, input({ amountText: "10,000", type: "payment" }), at(0));
  await voidPayment(store, { paymentId: payment.id, userId: "acct", reason: "bounced" }, at(1000));
  await recordPayment(store, input({ amountText: "10,000", type: "payment" }), at(200_000));
  assert.equal(summarize(store.jobs[0], await store.listPayments("j1")).collectedCents, 1_000_000);
});

test("record: needs a signed contract and an open job", async () => {
  for (const stage of ["new_lead", "scope_presented"] as const) {
    assert.equal(await code(recordPayment(setup({ stage }), input())), "no_signed_contract");
  }
  assert.equal(await code(recordPayment(setup({ contractCents: null }), input())), "no_signed_contract");
  assert.equal(await code(recordPayment(setup({ stage: "lost" }), input())), "job_closed");
  assert.equal(await code(recordPayment(setup(), input({ jobId: "nope" }))), "not_found");
});

test("record: amount and method validation", async () => {
  const store = setup();
  for (const amountText of ["", "0", "-5", "12.345", "abc"]) {
    assert.equal(await code(recordPayment(store, input({ amountText }))), "amount_invalid", amountText);
  }
  assert.equal(await code(recordPayment(store, input({ amountText: "1,000,001" }))), "amount_too_large");
  assert.equal(await code(recordPayment(store, input({ method: "bitcoin" }))), "method_invalid");
  assert.equal((await store.listPayments("j1")).length, 0);
});

test("record: card and ach need a reference (Helcim transaction number)", async () => {
  const store = setup();
  assert.equal(await code(recordPayment(store, input({ method: "card", reference: "  ", photo: null }))), "reference_required");
  assert.equal(await code(recordPayment(store, input({ method: "ach", reference: null, photo: null }))), "reference_required");
  const ok = await recordPayment(store, input({ method: "card", reference: " HELCIM-1 ", photo: null }), at(0));
  assert.equal(ok.payment.reference, "HELCIM-1");
});

test("record: estimators must photograph checks; office users may skip it", async () => {
  const store = setup();
  assert.equal(await code(recordPayment(store, input({ photo: null }))), "photo_required");
  await recordPayment(store, input({ photo: null, recorder: { id: "acct", role: "accounting" } }), at(0));
  await recordPayment(store, input({ photo: null, recorder: { id: "adm", role: "admin" }, amountText: "1,000" }), at(0));
  assert.equal((await store.listPayments("j1")).length, 2);
});

test("record: photo must be a real, small-enough JPEG, PNG or WebP", async () => {
  const store = setup();
  const bad = [
    { data: new Uint8Array(100) },
    { data: new TextEncoder().encode("GIF89a-not-allowed-here") },
    { data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(7 * 1024 * 1024).fill(1)]) }, // over 6 MB
  ];
  for (const photo of bad) assert.equal(await code(recordPayment(store, input({ photo }))), "photo_invalid");
  assert.equal(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0])), "image/png");
  const webp = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP"), 0]);
  assert.equal(sniffImageMime(webp), "image/webp");
});

test("record: depreciation only on insurance jobs", async () => {
  assert.equal(await code(recordPayment(setup(), input({ type: "depreciation" }))), "depreciation_not_allowed");
  const ins = setup({ jobType: "insurance" });
  const r = await recordPayment(ins, input({ type: "depreciation", method: "insurance_check" }), at(0));
  assert.equal(r.payment.isDepreciation, true);
  assert.equal(r.payment.isDeposit, false);
});

test("record: the same payment twice within 60 seconds is refused; later is allowed", async () => {
  const store = setup();
  await recordPayment(store, input(), at(0));
  assert.equal(await code(recordPayment(store, input(), at(30_000))), "duplicate");
  await recordPayment(store, input(), at(61_000));
  assert.equal((await store.listPayments("j1")).length, 2);
});

test("void: reason required, once only, and the record stays", async () => {
  const store = setup();
  const { payment } = await recordPayment(store, input(), at(0));
  assert.equal(await code(voidPayment(store, { paymentId: payment.id, userId: "acct", reason: " " })), "reason_required");
  assert.equal(await code(voidPayment(store, { paymentId: "nope", userId: "acct", reason: "typo" })), "not_found");
  await voidPayment(store, { paymentId: payment.id, userId: "acct", reason: "Entered twice" }, at(1000));
  assert.equal(await code(voidPayment(store, { paymentId: payment.id, userId: "acct", reason: "again" })), "already_voided");
  const rows = await store.listPayments("j1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].voidReason, "Entered twice");
});

test("void: flags a deposit that is no longer covered, without moving the stage back", async () => {
  const store = setup();
  const { payment } = await recordPayment(store, input({ amountText: "5,220", method: "card", reference: "H-1", photo: null }), at(0));
  assert.equal(store.jobs[0].stage, "deposit_collected");
  const r = await voidPayment(store, { paymentId: payment.id, userId: "acct", reason: "Card declined later" }, at(1000));
  assert.equal(r.depositNoLongerCovered, true);
  assert.equal(store.jobs[0].stage, "deposit_collected");
  assert.equal(summarize(store.jobs[0], await store.listPayments("j1")).depositDueCents, 522_000);
});

test("summary: deposit, collected and balance, ignoring voided payments", async () => {
  const store = setup();
  await recordPayment(store, input({ amountText: "2,000" }), at(0));
  await recordPayment(store, input({ amountText: "1,000", type: "payment", method: "cash", photo: null }), at(0));
  const s = summarize(store.jobs[0], await store.listPayments("j1"));
  assert.deepEqual(s, {
    contractCents: 1_044_000, depositRequiredCents: 522_000, depositPaidCents: 200_000, depositDueCents: 322_000,
    collectedCents: 300_000, balanceDueCents: 744_000, depositCovered: false,
  });
});

test("commission earned so far uses collected amount and the job's margin", () => {
  const job = baseJob(); // $10,440 sale, $6,264 cost -> 40% margin; own truck -> 10%
  assert.deepEqual(commissionEarnedSoFar(job, 522_000), { rateMarginBps: 4000, earnedCents: 52_200 });
  assert.equal(commissionEarnedSoFar(baseJob({ estimatorOwnTruck: false }), 522_000)?.earnedCents, 41_760);
  assert.equal(commissionEarnedSoFar(job, 0)?.earnedCents, 0);
  assert.equal(commissionEarnedSoFar(baseJob({ costCents: null }), 522_000), null);
});

test("roles: who can record, see commission, and void", () => {
  const job = { estimatorId: "est1" };
  assert.ok(canRecordPayments(user("est1", "estimator"), job));
  assert.ok(!canRecordPayments(user("est2", "estimator"), job));
  assert.ok(canRecordPayments(user("a", "admin"), job));
  assert.ok(canRecordPayments(user("acct", "accounting"), job));
  for (const r of ["csr", "production_manager", "crew_leader"] as const) assert.ok(!canRecordPayments(user("x", r), job), r);
  assert.ok(canSeeCommissionEarned(user("est1", "estimator"), job));
  assert.ok(!canSeeCommissionEarned(user("est2", "estimator"), job));
  assert.ok(canSeeCommissionEarned(user("acct", "accounting"), job));
  assert.ok(!canSeeCommissionEarned(user("pm", "production_manager"), job));
  assert.ok(canVoidPayments("admin") && canVoidPayments("accounting"));
  assert.ok(!canVoidPayments("estimator") && !canVoidPayments("csr"));
});

// ---------- Paid in full ----------
test("record: the payment that clears an invoiced job's balance moves it to paid in full", async () => {
  const store = setup({ stage: "invoiced", contractCents: 1_000_000, costCents: 600_000, depositRequiredCents: 0 });
  const part = await recordPayment(store, input({ amountText: "6,000", type: "payment" }), at(0));
  assert.equal(part.stageChanged, false);
  assert.equal(store.jobs[0].stage, "invoiced");
  const rest = await recordPayment(store, input({ amountText: "4,000", type: "payment", method: "card", reference: "HELCIM-9", photo: null }), at(120_000));
  assert.equal(rest.stageChanged, true);
  assert.equal(rest.summary.balanceDueCents, 0);
  assert.equal(store.jobs[0].stage, "paid_in_full");
  assert.deepEqual(store.history.map((h) => [h.from, h.to]), [["invoiced", "paid_in_full"]]);
});

test("record: an insurance job waiting on depreciation is paid in full when the last dollar arrives", async () => {
  const store = setup({ jobType: "insurance", stage: "depreciation_pending", contractCents: 1_000_000, costCents: 600_000, depositRequiredCents: 0 });
  await recordPayment(store, input({ amountText: "7,000", type: "payment", method: "insurance_check", reference: "CK-1" }), at(0));
  assert.equal(store.jobs[0].stage, "depreciation_pending");
  const last = await recordPayment(store, input({ amountText: "3,000", type: "depreciation", method: "insurance_check", reference: "CK-2" }), at(120_000));
  assert.equal(last.stageChanged, true);
  assert.equal(store.jobs[0].stage, "paid_in_full");
});

test("record: paying the whole contract early does not skip invoicing; stage waits for the invoice", async () => {
  for (const stage of ["in_production", "closeout_punchlist"] as const) {
    const store = setup({ stage, contractCents: 1_000_000, costCents: 600_000, depositRequiredCents: 0 });
    const r = await recordPayment(store, input({ amountText: "10,000", type: "payment" }), at(0));
    assert.equal(r.stageChanged, false, stage);
    assert.equal(store.jobs[0].stage, stage);
  }
});

test("void: voiding a payment on a paid-in-full job never moves the stage back", async () => {
  const store = setup({ stage: "invoiced", contractCents: 500_000, costCents: 300_000, depositRequiredCents: 0 });
  const r = await recordPayment(store, input({ amountText: "5,000", type: "payment" }), at(0));
  assert.equal(store.jobs[0].stage, "paid_in_full");
  await voidPayment(store, { paymentId: r.payment.id, userId: "adm", reason: "bounced check" }, at(60_000));
  assert.equal(store.jobs[0].stage, "paid_in_full");             // flagged for a person; never automatic
  assert.equal(store.history.length, 1);
});