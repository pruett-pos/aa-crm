import { test } from "node:test";
import assert from "node:assert/strict";
import {
  grossMarginBps, commissionRateBps, commissionEarnedCents,
  contingencyFeeCents, cancellationFeeCents, depositRequiredCents,
  pruettPriceCents, routeCall, stagesFor, nextStage,
  priceForTargetMarginCents, scopeTotals, scopeCommissionRateBps,
  depositDueCents, balanceDueCents, wouldOverpay, parseDollarsToCents, netPayout, allocateDraws,
  INVOICE_TERMS_DAYS, addDays, invoiceGate, stageAfterPayment,
} from "../src/lib/rules.ts";

test("gross margin", () => {
  assert.equal(grossMarginBps(2_000_000, 1_200_000), 4000); // 40%
  assert.equal(grossMarginBps(0, 100), 0);
});

test("commission: 8% at or above 40% GM, 10% with own truck", () => {
  assert.equal(commissionRateBps(4000, false), 800);
  assert.equal(commissionRateBps(4500, false), 800);
  assert.equal(commissionRateBps(4000, true), 1000);
});

test("commission: loses 1 point per full 2 points of GM below 40%", () => {
  assert.equal(commissionRateBps(3900, false), 800); // only 1 point below
  assert.equal(commissionRateBps(3800, false), 700);
  assert.equal(commissionRateBps(3500, false), 600);
  assert.equal(commissionRateBps(3600, true), 800);
  assert.equal(commissionRateBps(2000, false), 0);   // floor at 0
});

test("commission is paid on collected amount", () => {
  // $20k job at 40% GM, $10k collected so far → $800
  assert.equal(commissionEarnedCents(1_000_000, 4000, false), 80_000);
  assert.equal(commissionEarnedCents(0, 4000, false), 0);
});

test("insurance contingency and cancellation fees", () => {
  assert.equal(contingencyFeeCents(1_800_000), 180_000); // $18k payout → $1,800
  assert.equal(cancellationFeeCents(1_800_000), 90_000); // → $900
});

test("contingency fee is based on insurance paid so far, not RCV", () => {
  // $18k RCV approved, $12k ACV paid so far → fee on $12k only
  assert.equal(contingencyFeeCents(1_200_000), 120_000);
  assert.equal(contingencyFeeCents(0), 0);
  // depreciation released later → fee recalculated on the new running total
  assert.equal(contingencyFeeCents(1_800_000), 180_000);
});

test("upgrade scope earns retail commission on its own margin", () => {
  // $5k upgrade scope at 38% GM, fully collected → 7% = $350, independent of the insurance scope
  const margin = grossMarginBps(500_000, 310_000);
  assert.equal(margin, 3800);
  assert.equal(commissionEarnedCents(500_000, margin, false), 35_000);
});

test("scope pricing: target margin sets price = cost / (1 - target)", () => {
  assert.equal(priceForTargetMarginCents(60_000, 4000), 100_000); // $600 cost -> $1,000 at 40%
  assert.equal(priceForTargetMarginCents(60_000, 0), 60_000);     // 0% target: price = cost
  assert.equal(priceForTargetMarginCents(0, 4000), 0);
  assert.throws(() => priceForTargetMarginCents(60_000, 9600));
  assert.throws(() => priceForTargetMarginCents(60_000, -1));
  assert.throws(() => priceForTargetMarginCents(60_000, 3999.5));
});

test("scope totals: sums lines and reports gross margin", () => {
  const lines = [
    { quantity: 10, unitCostCents: 3_000, unitPriceCents: 5_000 },   // $300 / $500
    { quantity: 2.5, unitCostCents: 12_000, unitPriceCents: 20_000 }, // $300 / $500
  ];
  assert.deepEqual(scopeTotals(lines), { costCents: 60_000, saleCents: 100_000, marginBps: 4000 });
  assert.deepEqual(scopeTotals([]), { costCents: 0, saleCents: 0, marginBps: 0 });
});

test("scope totals: fractional quantities round per line", () => {
  const t = scopeTotals([{ quantity: 0.333, unitCostCents: 1_000, unitPriceCents: 1_667 }]);
  assert.equal(t.costCents, 333);
  assert.equal(t.saleCents, 555);
});

test("scope commission preview: 40% pays 8%, 38% pays 7%, 39% still 8%", () => {
  const at = (marginBps: number) => scopeCommissionRateBps({ costCents: 0, saleCents: 0, marginBps }, false);
  assert.equal(at(4000), 800);
  assert.equal(at(3900), 800);
  assert.equal(at(3800), 700);
  assert.equal(scopeCommissionRateBps({ costCents: 0, saleCents: 0, marginBps: 4000 }, true), 1000);
});

test("payments: deposit due and balance never go negative", () => {
  assert.equal(depositDueCents(522_000, 0), 522_000);
  assert.equal(depositDueCents(522_000, 200_000), 322_000);
  assert.equal(depositDueCents(522_000, 522_000), 0);
  assert.equal(depositDueCents(522_000, 600_000), 0);
  assert.equal(depositDueCents(0, 0), 0);
  assert.equal(balanceDueCents(1_044_000, 522_000), 522_000);
  assert.equal(balanceDueCents(1_044_000, 1_044_000), 0);
  assert.equal(balanceDueCents(1_044_000, 2_000_000), 0);
});

test("payments: overpay boundary", () => {
  assert.equal(wouldOverpay(1_000, 600, 400), false); // exactly the total is fine
  assert.equal(wouldOverpay(1_000, 600, 401), true);
  assert.equal(wouldOverpay(1_000, 0, 1_000), false);
});

test("payments: dollar parsing is exact and strict", () => {
  assert.equal(parseDollarsToCents("1234"), 123_400);
  assert.equal(parseDollarsToCents("1,234.50"), 123_450);
  assert.equal(parseDollarsToCents("$99.9"), 9_990);
  assert.equal(parseDollarsToCents(" 0.07 "), 7);
  assert.equal(parseDollarsToCents("19.99"), 1_999); // would be 1998.9999 as a float multiply
  assert.equal(parseDollarsToCents("1.005"), null);   // no sub-cent values
  for (const bad of ["", "0", "0.00", "-5", "abc", "1e3", "1,23", "12,34,567", "$", "5.", ".5", "1 000", "99999999999999999999"]) {
    assert.equal(parseDollarsToCents(bad), null, bad);
  }
});

test("payments: commission earned on amount collected, not sold", () => {
  // $10,440 job at 40% margin, $5,220 collected so far -> 8% -> $417.60
  assert.equal(commissionEarnedCents(522_000, 4000, false), 41_760);
  assert.equal(commissionEarnedCents(522_000, 4000, true), 52_200);   // own truck: 10%
  assert.equal(commissionEarnedCents(522_000, 3800, false), 36_540);  // 38% margin: 7%
  assert.equal(commissionEarnedCents(0, 4000, true), 0);
});

test("payout: draws are absorbed up to what was earned; leftovers stay outstanding", () => {
  assert.deepEqual(netPayout(100_000, 0), { payCents: 100_000, drawsAppliedCents: 0 });
  assert.deepEqual(netPayout(100_000, 30_000), { payCents: 70_000, drawsAppliedCents: 30_000 });
  assert.deepEqual(netPayout(100_000, 100_000), { payCents: 0, drawsAppliedCents: 100_000 });
  assert.deepEqual(netPayout(100_000, 250_000), { payCents: 0, drawsAppliedCents: 100_000 }); // 150k stays owed
  assert.deepEqual(netPayout(0, 50_000), { payCents: 0, drawsAppliedCents: 0 });
  assert.deepEqual(netPayout(-5_000, 50_000), { payCents: 0, drawsAppliedCents: 0 });          // clawback carries forward
});

test("payout: draws are used oldest first, a partly used draw keeps its remainder", () => {
  const draws = [{ id: "a", outstandingCents: 30_000 }, { id: "b", outstandingCents: 50_000 }, { id: "c", outstandingCents: 20_000 }];
  assert.deepEqual(allocateDraws(draws, 0), []);
  assert.deepEqual(allocateDraws(draws, 20_000), [{ id: "a", amountCents: 20_000 }]);
  assert.deepEqual(allocateDraws(draws, 30_000), [{ id: "a", amountCents: 30_000 }]);
  assert.deepEqual(allocateDraws(draws, 60_000), [{ id: "a", amountCents: 30_000 }, { id: "b", amountCents: 30_000 }]);
  assert.deepEqual(allocateDraws(draws, 100_000).map((x) => x.amountCents), [30_000, 50_000, 20_000]);
  assert.throws(() => allocateDraws(draws, 100_001));
  assert.throws(() => allocateDraws(draws, -1));
});

test("deposit: 50% over $5k or with special-order materials", () => {
  assert.equal(depositRequiredCents(500_000, false), 0);        // exactly $5k: none
  assert.equal(depositRequiredCents(500_100, false), 250_050);
  assert.equal(depositRequiredCents(300_000, true), 150_000);
  assert.equal(depositRequiredCents(300_000, false), 0);
});

test("Pruett Builder plan is retail minus 12%", () => {
  assert.equal(pruettPriceCents(10_000), 8_800);
  assert.equal(pruettPriceCents(10_000, "wholesale"), 8_200);
});

test("call routing", () => {
  const pms = { siding: "pm-siding" };
  assert.deepEqual(routeCall("est-1", "siding", pms), { kind: "estimator", userId: "est-1" });
  assert.deepEqual(routeCall(null, "siding", pms), { kind: "production_manager", userId: "pm-siding" });
  assert.throws(() => routeCall(null, "roofing", pms));
});

test("pipeline: retail skips insurance stages; deposit stage skipped when none due", () => {
  assert.ok(!stagesFor("retail").includes("claim_approved"));
  assert.equal(stagesFor("insurance").length, 15);
  assert.equal(nextStage("contract_signed", "retail", 0), "materials_ordered");
  assert.equal(nextStage("contract_signed", "retail", 250_000), "deposit_collected");
  assert.equal(nextStage("inspected", "insurance", 0), "contingency_signed");
  assert.equal(nextStage("paid_in_full", "insurance", 0), null);
});

// ---------- Closeout and invoicing ----------
const done = (n: number) => Array.from({ length: n }, () => ({ done: true }));
const gate = (over: Partial<Parameters<typeof invoiceGate>[0]> = {}) =>
  invoiceGate({ stage: "closeout_punchlist", contractSigned: true, items: done(3), hasLiveInvoice: false, ...over });

test("invoice gate: closeout, signed contract, a complete punchlist, no live invoice", () => {
  assert.deepEqual(gate(), { ok: true });
  assert.deepEqual(gate({ items: [...done(2), { done: false }] }), { ok: false, reason: "punchlist_open" });
  assert.deepEqual(gate({ items: [] }), { ok: false, reason: "no_punchlist" });         // an empty list is not a finished list
  assert.deepEqual(gate({ contractSigned: false }), { ok: false, reason: "no_contract" });
  assert.deepEqual(gate({ hasLiveInvoice: true }), { ok: false, reason: "invoice_exists" });
});

test("invoice gate: only closeout, or invoiced (to reissue after a void); nothing earlier or later or closed", () => {
  for (const stage of ["new_lead", "contract_signed", "deposit_collected", "scheduled", "in_production", "depreciation_pending", "paid_in_full", "lost", "cancelled_after_approval"]) {
    assert.deepEqual(gate({ stage }), { ok: false, reason: "wrong_stage" }, stage);
  }
  assert.deepEqual(gate({ stage: "invoiced" }), { ok: true });
  assert.deepEqual(gate({ stage: "invoiced", hasLiveInvoice: true }), { ok: false, reason: "invoice_exists" });
});

test("paid in full: an invoiced job at a zero balance, never anything else, never backward", () => {
  assert.equal(stageAfterPayment("invoiced", 0), "paid_in_full");
  assert.equal(stageAfterPayment("depreciation_pending", 0), "paid_in_full");
  assert.equal(stageAfterPayment("invoiced", 1), null);                  // one cent short
  assert.equal(stageAfterPayment("invoiced", 250_000), null);
  for (const stage of ["closeout_punchlist", "in_production", "deposit_collected", "paid_in_full", "lost"]) assert.equal(stageAfterPayment(stage, 0), null, stage);
});

test("terms are due on receipt; date arithmetic is exact across month and year ends", () => {
  assert.equal(INVOICE_TERMS_DAYS, 0);
  assert.equal(addDays("2026-10-14", INVOICE_TERMS_DAYS), "2026-10-14");
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-12-31", 10), "2027-01-10");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});