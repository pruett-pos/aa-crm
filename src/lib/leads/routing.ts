import { routeCall, type Division } from "../rules.ts";

export type Market = "west_plains" | "springfield" | "nw_arkansas";
export type PmRow = { division: Division; market: Market; userId: string };

/** The PM for a division: the one in the property's market if there is one, else any PM for that division. */
export function pickPm(rows: PmRow[], division: Division, market: Market): string | undefined {
  const forDivision = rows.filter((r) => r.division === division);
  return (forDivision.find((r) => r.market === market) ?? forDivision[0])?.userId;
}

export type RouteResult = {
  estimatorId: string | null;
  productionManagerId: string | null;
  via: "override" | "last_estimator" | "division_pm" | "none";
  /** True when nobody could be assigned; a person has to pick. */
  needsAssignment: boolean;
};

/**
 * SPEC section 2: existing customer -> the estimator who handled them last; otherwise the
 * Production Manager of the requested division (the first division selected). A CSR override wins.
 * A division with no PM is not an error: the lead is created unassigned and flagged.
 */
export function routeLead(a: {
  lastEstimatorId: string | null;
  divisions: Division[];
  market: Market;
  pmRows: PmRow[];
  overrideEstimatorId?: string | null;
}): RouteResult {
  if (a.overrideEstimatorId) {
    return { estimatorId: a.overrideEstimatorId, productionManagerId: null, via: "override", needsAssignment: false };
  }
  const primary = a.divisions[0];
  if (!primary) return { estimatorId: null, productionManagerId: null, via: "none", needsAssignment: true };
  const pm = pickPm(a.pmRows, primary, a.market);
  try {
    const target = routeCall(a.lastEstimatorId, primary, pm ? { [primary]: pm } : {});
    return target.kind === "estimator"
      ? { estimatorId: target.userId, productionManagerId: null, via: "last_estimator", needsAssignment: false }
      : { estimatorId: null, productionManagerId: target.userId, via: "division_pm", needsAssignment: false };
  } catch {
    return { estimatorId: null, productionManagerId: null, via: "none", needsAssignment: true };
  }
}
