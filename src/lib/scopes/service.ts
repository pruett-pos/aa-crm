import {
  SCOPE_MAX_TARGET_MARGIN_BPS, pruettPriceCents, priceForTargetMarginCents,
  scopeTotals, scopeCommissionRateBps, STAGES, type Division,
} from "../rules.ts";
import { can, type Role } from "../auth/roles.ts";
import type { AuthUser } from "../auth/store.ts";
import {
  TIERS, type ComputedItem, type ComputedScope, type JobAccess, type Product,
  type ScopeInput, type StoredScope,
} from "./types.ts";

export class ScopeInputError extends Error {}

/** A unit like sq, lf, ea, hr: 1 to 8 letters. Missing means "ea". */
function cleanUnit(raw: string | undefined, lineIndex: number): string {
  const u = (raw ?? "").trim().toLowerCase();
  if (u === "") return "ea";
  if (!/^[a-z]{1,8}$/.test(u)) throw new ScopeInputError(`Line ${lineIndex + 1}: the unit should be 1 to 8 letters, like sq or lf`);
  return u;
}

const MAX_ITEMS = 200;
const MAX_QUANTITY = 100_000;
const MAX_UNIT_COST_CENTS = 100_000_000; // $1M per unit is surely a typo

/**
 * Validate the estimator's input and compute every price on the server.
 * Materials cost the Pruett Builder price; customer price comes from the target margin.
 */
export function computeScope(input: ScopeInput, catalog: Product[], jobDivisions: readonly Division[]): ComputedScope {
  if (!(TIERS as readonly string[]).includes(input.tier)) throw new ScopeInputError("Unknown package tier");
  if (!jobDivisions.includes(input.division)) throw new ScopeInputError("That trade isn't on this job");
  if (!input.title.trim()) throw new ScopeInputError("Title is required");
  if (
    !Number.isInteger(input.targetMarginBps) ||
    input.targetMarginBps < 0 || input.targetMarginBps > SCOPE_MAX_TARGET_MARGIN_BPS
  ) throw new ScopeInputError("Target margin must be between 0% and 95%");
  if (input.items.length > MAX_ITEMS) throw new ScopeInputError("Too many lines");

  const byId = new Map(catalog.map((p) => [p.id, p]));
  const items: ComputedItem[] = input.items.map((it, i) => {
    if (!(it.quantity > 0) || it.quantity > MAX_QUANTITY) throw new ScopeInputError(`Line ${i + 1}: quantity must be above 0`);
    let unitCostCents: number;
    let description: string;
    let productId: string | null = null;
    let unit: string | null = null;
    if (it.kind === "material") {
      const p = it.productId ? byId.get(it.productId) : undefined;
      if (!p) throw new ScopeInputError(`Line ${i + 1}: pick a product from the catalog`);
      productId = p.id;
      description = p.name;
      unitCostCents = pruettPriceCents(p.retailCents);
    } else if (it.kind === "labor" || it.kind === "misc") {
      description = (it.description ?? "").trim();
      if (!description) throw new ScopeInputError(`Line ${i + 1}: description is required`);
      const c = it.unitCostCents;
      if (c === undefined || !Number.isInteger(c) || c < 0 || c > MAX_UNIT_COST_CENTS) {
        throw new ScopeInputError(`Line ${i + 1}: enter a cost`);
      }
      unitCostCents = c;
      unit = cleanUnit(it.unit, i);
    } else {
      throw new ScopeInputError(`Line ${i + 1}: unknown line type`);
    }
    return {
      kind: it.kind, sortOrder: i, productId, description,
      quantity: it.quantity, unitCostCents,
      unitPriceCents: priceForTargetMarginCents(unitCostCents, input.targetMarginBps),
      color: it.color?.trim() || null, unit,
    };
  });

  const totals = scopeTotals(items);
  return {
    division: input.division, tier: input.tier, title: input.title.trim(), targetMarginBps: input.targetMarginBps,
    items, ...totals,
  };
}

// ---------- Access ----------
const CONTRACT_INDEX = STAGES.indexOf("contract_signed");

/** Admins, and the estimator who owns the job. */
export function canWriteScopes(user: AuthUser, job: JobAccess): boolean {
  if (user.role === "admin") return true;
  return user.role === "estimator" && job.estimatorId === user.id;
}

/**
 * Read access: admin; the job's estimator; and a Production Manager for their
 * division's jobs from contract onward (SPEC section 1).
 */
export function canReadScopes(user: AuthUser, job: JobAccess, managerIds: string[]): boolean {
  if (canWriteScopes(user, job)) return true;
  if (user.role !== "production_manager") return false;
  const manages = job.productionManagerId === user.id || managerIds.includes(user.id);
  const stageIndex = STAGES.indexOf(job.stage as (typeof STAGES)[number]);
  return manages && stageIndex >= CONTRACT_INDEX;
}

// ---------- Response shaping ----------
export type ScopeView = {
  id: string;
  division: Division;
  selected: boolean;
  tier: ComputedScope["tier"];
  title: string;
  items: {
    kind: ComputedItem["kind"]; description: string; quantity: number;
    unitPriceCents: number; color: string | null; productId: string | null; unit: string | null;
    unitCostCents?: number;
  }[];
  saleCents: number;
  // Present only for roles that may see margin (never on the customer PDF).
  targetMarginBps?: number;
  costCents?: number;
  marginBps?: number;
  // Present only for the job's own estimator, or roles that see all commissions.
  commissionRateBps?: number;
};

export function toView(
  scope: StoredScope, role: Role, opts: { isOwnJobEstimator: boolean; estimatorOwnTruck: boolean },
): ScopeView {
  const showMargin = can(role, "seeScopeMargin");
  const showCommission =
    can(role, "seeAllCommissions") ||
    (can(role, "seeOwnCommissions") && opts.isOwnJobEstimator) ||
    role === "admin";
  const view: ScopeView = {
    id: scope.id, division: scope.division, selected: scope.selected, tier: scope.tier, title: scope.title, saleCents: scope.saleCents,
    items: scope.items.map((i) => ({
      kind: i.kind, description: i.description, quantity: i.quantity,
      unitPriceCents: i.unitPriceCents, color: i.color, productId: i.productId, unit: i.unit ?? null,
      ...(showMargin ? { unitCostCents: i.unitCostCents } : {}),
    })),
  };
  if (showMargin) {
    view.targetMarginBps = scope.targetMarginBps;
    view.costCents = scope.costCents;
    view.marginBps = scope.marginBps;
  }
  if (showCommission) {
    view.commissionRateBps = scopeCommissionRateBps(scope, opts.estimatorOwnTruck);
  }
  return view;
}
