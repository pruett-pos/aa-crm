import { STAGES, depositRequiredCents, type Stage } from "../rules.ts";

export type SelectableScope = {
  saleCents: number;
  costCents: number;
  items: { kind: string; productId: string | null }[];
};

export type Selection = {
  contractCents: number;
  costCents: number;
  hasSpecialOrder: boolean;
  depositRequiredCents: number;
  /** Stage the job should be in after the customer picks this package. */
  stage: Stage;
};

export class SelectionError extends Error {}

const SCOPE_PRESENTED = STAGES.indexOf("scope_presented");

/**
 * What changes on the job when the customer picks a package. Deposit comes from
 * `depositRequiredCents` in rules.ts; a special-order material forces the deposit.
 * The stage moves up to "scope_presented" but never backward.
 */
export function selectScope(
  scope: SelectableScope, specialOrderProductIds: Set<string>, currentStage: Stage | "lost" | "cancelled_after_approval",
): Selection {
  if (currentStage === "lost" || currentStage === "cancelled_after_approval") {
    throw new SelectionError("This job is closed");
  }
  if (scope.saleCents <= 0 || scope.items.length === 0) {
    throw new SelectionError("Add priced lines to this package before selecting it");
  }
  const hasSpecialOrder = scope.items.some(
    (i) => i.kind === "material" && i.productId !== null && specialOrderProductIds.has(i.productId),
  );
  const index = STAGES.indexOf(currentStage);
  return {
    contractCents: scope.saleCents,
    costCents: scope.costCents,
    hasSpecialOrder,
    depositRequiredCents: depositRequiredCents(scope.saleCents, hasSpecialOrder),
    stage: index < SCOPE_PRESENTED ? "scope_presented" : currentStage,
  };
}
