// A&A business rules. All money in integer cents, all rates in basis points
// (1% = 100 bps). Every function here is covered by tests/rules.test.ts.

export type Division =
  | "roofing" | "siding" | "gutters" | "windows_doors"
  | "insulation" | "spray_foam" | "commercial";

// ---------- Commission ----------
export const COMMISSION_BASE_BPS = 800;          // 8%
export const COMMISSION_OWN_TRUCK_BPS = 1000;    // 10% with own truck + fuel
export const COMMISSION_MARGIN_TARGET_BPS = 4000; // 40% gross margin
export const COMMISSION_STEP_MARGIN_BPS = 200;   // every 2 points below target...
export const COMMISSION_STEP_PENALTY_BPS = 100;  // ...costs 1 point of commission

/** Gross margin in bps: (sale - cost) / sale. */
export function grossMarginBps(saleCents: number, costCents: number): number {
  if (saleCents <= 0) return 0;
  return Math.round(((saleCents - costCents) * 10000) / saleCents);
}

/**
 * Commission rate for a job. Uses full 2-point steps below 40% GM
 * (SPEC open question #1). Never below 0.
 */
export function commissionRateBps(marginBps: number, ownTruck: boolean): number {
  const base = ownTruck ? COMMISSION_OWN_TRUCK_BPS : COMMISSION_BASE_BPS;
  if (marginBps >= COMMISSION_MARGIN_TARGET_BPS) return base;
  const shortfall = COMMISSION_MARGIN_TARGET_BPS - marginBps;
  const steps = Math.floor(shortfall / COMMISSION_STEP_MARGIN_BPS);
  return Math.max(0, base - steps * COMMISSION_STEP_PENALTY_BPS);
}

/** Commission earned so far — paid on amount collected, not amount sold. */
export function commissionEarnedCents(
  collectedCents: number, marginBps: number, ownTruck: boolean,
): number {
  return Math.round((collectedCents * commissionRateBps(marginBps, ownTruck)) / 10000);
}

// ---------- Scope of work pricing ----------
export const SCOPE_DEFAULT_TARGET_MARGIN_BPS = 4000; // 40%
export const SCOPE_MAX_TARGET_MARGIN_BPS = 9500;     // 95%: keeps price finite and sane

/** Customer price for a cost at a target gross margin: cost / (1 - target). */
export function priceForTargetMarginCents(costCents: number, targetBps: number): number {
  if (!Number.isInteger(targetBps) || targetBps < 0 || targetBps > SCOPE_MAX_TARGET_MARGIN_BPS) {
    throw new RangeError(`Target margin must be 0 to ${SCOPE_MAX_TARGET_MARGIN_BPS} bps`);
  }
  return Math.round((costCents * 10000) / (10000 - targetBps));
}

export type ScopeLine = { quantity: number; unitCostCents: number; unitPriceCents: number };
export type ScopeTotals = { costCents: number; saleCents: number; marginBps: number };

/** Totals for a scope. Each line rounds to whole cents before summing. */
export function scopeTotals(lines: ScopeLine[]): ScopeTotals {
  let costCents = 0;
  let saleCents = 0;
  for (const l of lines) {
    costCents += Math.round(l.quantity * l.unitCostCents);
    saleCents += Math.round(l.quantity * l.unitPriceCents);
  }
  return { costCents, saleCents, marginBps: grossMarginBps(saleCents, costCents) };
}

/** Commission rate the estimator would earn if this scope sells as priced. */
export function scopeCommissionRateBps(totals: ScopeTotals, ownTruck: boolean): number {
  return commissionRateBps(totals.marginBps, ownTruck);
}

// ---------- Reporting ----------
/** A rate in basis points (e.g. close rate): part / whole, rounded. Zero when there is nothing to divide by. */
export function rateBps(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part * 10000) / whole);
}

/** Spend divided by a count (cost per lead, cost per won job), in whole cents. Null when the count is zero. */
export function costPerCents(spendCents: number, count: number): number | null {
  if (count <= 0) return null;
  return Math.round(spendCents / count);
}

// ---------- Commission payouts and draws ----------
/**
 * What to pay for a period: everything unpaid and earned, minus draws already advanced.
 * Draws are absorbed up to the earned amount; any draw left over stays outstanding for next time.
 * Nothing is paid (and nothing is absorbed) if the unpaid total is zero or negative.
 */
export function netPayout(unpaidCents: number, drawsOutstandingCents: number): { payCents: number; drawsAppliedCents: number } {
  if (unpaidCents <= 0) return { payCents: 0, drawsAppliedCents: 0 };
  const drawsAppliedCents = Math.min(Math.max(0, drawsOutstandingCents), unpaidCents);
  return { payCents: unpaidCents - drawsAppliedCents, drawsAppliedCents };
}

/** Spread an applied amount across draws oldest first; a partly used draw keeps its remainder. */
export function allocateDraws(
  draws: { id: string; outstandingCents: number }[], appliedCents: number,
): { id: string; amountCents: number }[] {
  const total = draws.reduce((s, d) => s + d.outstandingCents, 0);
  if (appliedCents < 0 || appliedCents > total) throw new RangeError("Applied amount exceeds outstanding draws");
  const out: { id: string; amountCents: number }[] = [];
  let left = appliedCents;
  for (const d of draws) {
    if (left === 0) break;
    const take = Math.min(left, d.outstandingCents);
    if (take > 0) out.push({ id: d.id, amountCents: take });
    left -= take;
  }
  return out;
}

// ---------- Insurance contingency ----------
export const CONTINGENCY_FEE_BPS = 1000;   // 10% of insurance paid so far
export const CANCELLATION_FEE_BPS = 500;   // 5% of payout if homeowner walks after approval

/**
 * Contingency fee is 10% of what insurance has actually paid (ACV check, then
 * released depreciation) — not of approved RCV. Pass the running total of
 * carrier payments; the fee grows as payments arrive. Upgrade work is a
 * separate retail scope and is never included here.
 */
export function contingencyFeeCents(insurancePaidCents: number): number {
  return Math.round((insurancePaidCents * CONTINGENCY_FEE_BPS) / 10000);
}
export function cancellationFeeCents(payoutCents: number): number {
  return Math.round((payoutCents * CANCELLATION_FEE_BPS) / 10000);
}

// ---------- Deposits ----------
export const DEPOSIT_THRESHOLD_CENTS = 500_000; // $5,000
export const DEPOSIT_BPS = 5000;                // 50%

export function depositRequiredCents(contractCents: number, hasSpecialOrder: boolean): number {
  if (contractCents > DEPOSIT_THRESHOLD_CENTS || hasSpecialOrder) {
    return Math.round((contractCents * DEPOSIT_BPS) / 10000);
  }
  return 0;
}

// ---------- Payments ----------
export const PAYMENT_MAX_CENTS = 100_000_000; // $1,000,000 in one payment is surely a typo

/** Deposit still owed after what has been paid toward it. Never negative. */
export function depositDueCents(requiredCents: number, depositPaidCents: number): number {
  return Math.max(0, requiredCents - depositPaidCents);
}

/** Contract total minus everything collected so far. Never negative. */
export function balanceDueCents(contractCents: number, collectedCents: number): number {
  return Math.max(0, contractCents - collectedCents);
}

/** True if recording this payment would take total collected above the contract total. */
export function wouldOverpay(contractCents: number, collectedCents: number, amountCents: number): boolean {
  return collectedCents + amountCents > contractCents;
}

/**
 * Parse money typed by a person into whole cents, or null if it isn't a clean amount.
 * Accepts "1234", "1,234.50", "$99.9". Never uses floating point.
 */
export function parseDollarsToCents(input: string): number | null {
  const s = input.trim().replace(/^\$/, "");
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.replace(/,/g, "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

// ---------- Pruett pricing ----------
export const PRUETT_PLANS_BPS = {
  contractor: 700, contractor2: 300, builder: 1200, wholesale: 1800,
} as const;
export type PruettPlan = keyof typeof PRUETT_PLANS_BPS;

/** A&A buys at Builder (retail − 12%). */
export function pruettPriceCents(retailCents: number, plan: PruettPlan = "builder"): number {
  return Math.round((retailCents * (10000 - PRUETT_PLANS_BPS[plan])) / 10000);
}

// ---------- Inspections ----------
export const CONDITION_REPORT_PRICE_CENTS = 24_900; // $249

// ---------- Call routing ----------
export type RouteTarget =
  | { kind: "estimator"; userId: string }
  | { kind: "production_manager"; userId: string };

/** Existing customer → their last estimator; otherwise → the division's PM. */
export function routeCall(
  lastEstimatorId: string | null,
  division: Division,
  pmByDivision: Partial<Record<Division, string>>,
): RouteTarget {
  if (lastEstimatorId) return { kind: "estimator", userId: lastEstimatorId };
  const pm = pmByDivision[division];
  if (!pm) throw new Error(`No Production Manager assigned for ${division}`);
  return { kind: "production_manager", userId: pm };
}

// ---------- Pipeline ----------
export const STAGES = [
  "new_lead", "appointment_set", "inspected",
  "contingency_signed", "claim_approved",
  "scope_presented", "contract_signed", "deposit_collected",
  "materials_ordered", "scheduled", "in_production",
  "closeout_punchlist", "invoiced", "depreciation_pending", "paid_in_full",
] as const;
export type Stage = (typeof STAGES)[number];
const INSURANCE_ONLY: Stage[] = ["contingency_signed", "claim_approved", "depreciation_pending"];

export function stagesFor(jobType: "retail" | "insurance"): Stage[] {
  return jobType === "insurance" ? [...STAGES] : STAGES.filter((s) => !INSURANCE_ONLY.includes(s));
}

/** Next stage; deposit stage is skipped when no deposit is required. */
export function nextStage(
  current: Stage, jobType: "retail" | "insurance", depositCents: number,
): Stage | null {
  const list = stagesFor(jobType);
  let i = list.indexOf(current) + 1;
  if (list[i] === "deposit_collected" && depositCents === 0) i++;
  return list[i] ?? null;
}
