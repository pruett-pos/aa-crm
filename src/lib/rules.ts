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

// ---------- Insurance contingency ----------
export const CONTINGENCY_FEE_BPS = 1000;   // 10% of payout
export const CANCELLATION_FEE_BPS = 500;   // 5% of payout if homeowner walks after approval

export function contingencyFeeCents(payoutCents: number): number {
  return Math.round((payoutCents * CONTINGENCY_FEE_BPS) / 10000);
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
