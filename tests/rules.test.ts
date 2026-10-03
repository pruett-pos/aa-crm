import { test } from "node:test";
import assert from "node:assert/strict";
import {
  grossMarginBps, commissionRateBps, commissionEarnedCents,
  contingencyFeeCents, cancellationFeeCents, depositRequiredCents,
  pruettPriceCents, routeCall, stagesFor, nextStage,
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
