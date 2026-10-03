import { STAGES, depositRequiredCents, type Stage } from "../rules.ts";

export type SelectableScope = {
  saleCents: number;
  costCents: number;
  items: { kind: string; productId: string | null }[];
};

/** What the job carries once packages are chosen: the sum over every trade's chosen package. */
export type Combined = {
  contractCents: number;
  costCents: number;
  hasSpecialOrder: boolean;
  depositRequiredCents: number;
  /** Trades that have a chosen package. */
  selectedDivisions: string[];
};

export class SelectionError extends Error {}

const SCOPE_PRESENTED = STAGES.indexOf("scope_presented");

/** A package can be chosen only if it is priced and the job is still open. */
export function validateSelectable(scope: SelectableScope, currentStage: Stage | "lost" | "cancelled_after_approval"): void {
  if (currentStage === "lost" || currentStage === "cancelled_after_approval") {
    throw new SelectionError("This job is closed");
  }
  if (scope.saleCents <= 0 || scope.items.length === 0) {
    throw new SelectionError("Add priced lines to this package before selecting it");
  }
}

/**
 * Combine the chosen package of each trade into the job's contract figures. The deposit rule from rules.ts
 * applies to the COMBINED total (so two $3,000 trades need a deposit), and a special-order material in any
 * chosen package forces it.
 */
export function combineSelections(
  selected: (SelectableScope & { division: string })[], specialOrderProductIds: Set<string>,
): Combined {
  const contractCents = selected.reduce((s, x) => s + x.saleCents, 0);
  const costCents = selected.reduce((s, x) => s + x.costCents, 0);
  const hasSpecialOrder = selected.some((x) =>
    x.items.some((i) => i.kind === "material" && i.productId !== null && specialOrderProductIds.has(i.productId)));
  return {
    contractCents, costCents, hasSpecialOrder,
    depositRequiredCents: depositRequiredCents(contractCents, hasSpecialOrder),
    selectedDivisions: selected.map((x) => x.division),
  };
}

/** Choosing a package moves the job up to "scope presented", never backward. */
export function stageAfterSelection(current: Stage | "lost" | "cancelled_after_approval"): Stage | "lost" | "cancelled_after_approval" {
  if (current === "lost" || current === "cancelled_after_approval") return current;
  return STAGES.indexOf(current) < SCOPE_PRESENTED ? "scope_presented" : current;
}
