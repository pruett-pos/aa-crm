import type { Measurements } from "../measurements/types.ts";
import { TIERS, type Product, type ScopeItemInput, type Tier } from "../scopes/types.ts";
import { LABOR_BASIS, isLaborRole, isMaterialRole, laborQuantity, materialQuantity, takeoffBasis } from "./roofing.ts";

/** One row of the roofing assembly settings: what fills a role in a package tier. */
export type AssemblyLine = {
  tier: Tier;
  role: string;
  kind: "material" | "labor";
  productId: string | null;
  description: string | null;
  unit: string | null;
  coverage: number | null;
  unitCostCents: number | null;
  sortOrder: number;
  enabled: boolean;
};

export type SkipReason = "no_product" | "no_rate" | "not_needed" | "unknown_role" | "bad_line";
export type SkippedLine = { tier: Tier; role: string; reason: SkipReason };
export type BuiltTier = { tier: Tier; title: string; items: ScopeItemInput[] };

const TIER_LABEL: Record<Tier, string> = { good: "Good", better: "Better", best: "Best" };

/**
 * Turn measurements and the assembly settings into a scope draft for each package tier. A role with no product, or a labor
 * line with no rate, is left out and reported: the estimator fills it in, and the CRM never guesses a product or a price.
 * Quantities come from the takeoff; prices are not decided here (computeScope prices every line on the server).
 */
export function buildRoofingTiers(a: { measurements: Measurements; wastePct: number; lines: AssemblyLine[]; products: Product[] }): { tiers: BuiltTier[]; skipped: SkippedLine[] } {
  const basis = takeoffBasis(a.measurements, a.wastePct);
  const byId = new Map(a.products.map((p) => [p.id, p]));
  const tiers: BuiltTier[] = [];
  const skipped: SkippedLine[] = [];

  for (const tier of TIERS) {
    const items: ScopeItemInput[] = [];
    let shingleName: string | null = null;
    const lines = a.lines.filter((l) => l.tier === tier && l.enabled).sort((x, y) => x.sortOrder - y.sortOrder || x.role.localeCompare(y.role));
    for (const l of lines) {
      if (l.kind === "material") {
        if (!isMaterialRole(l.role)) { skipped.push({ tier, role: l.role, reason: "unknown_role" }); continue; }
        const product = l.productId ? byId.get(l.productId) : undefined;
        if (!product) { skipped.push({ tier, role: l.role, reason: "no_product" }); continue; }
        const quantity = materialQuantity(l.role, basis, l.coverage);
        if (quantity <= 0) { skipped.push({ tier, role: l.role, reason: "not_needed" }); continue; }
        if (l.role === "shingles") shingleName = product.name;
        items.push({ kind: "material", productId: product.id, quantity });
      } else if (l.kind === "labor") {
        if (!isLaborRole(l.role)) { skipped.push({ tier, role: l.role, reason: "unknown_role" }); continue; }
        if (l.unitCostCents === null || !Number.isInteger(l.unitCostCents) || l.unitCostCents < 0) { skipped.push({ tier, role: l.role, reason: "no_rate" }); continue; }
        const quantity = laborQuantity(l.role, basis);
        if (quantity <= 0) { skipped.push({ tier, role: l.role, reason: "not_needed" }); continue; }
        items.push({
          kind: "labor", description: (l.description?.trim() || LABOR_BASIS[l.role].label).slice(0, 200), quantity, unitCostCents: l.unitCostCents,
          unit: (l.unit?.trim() || LABOR_BASIS[l.role].unit).toLowerCase(),
        });
      } else {
        skipped.push({ tier, role: l.role, reason: "bad_line" });
      }
    }
    if (items.length > 0) tiers.push({ tier, title: shingleName ? `${TIER_LABEL[tier]} - ${shingleName}` : TIER_LABEL[tier], items });
  }
  return { tiers, skipped };
}
