import type { Division } from "../rules.ts";
import type { ReportTable } from "../reports/types.ts";
import type { StoredScope } from "../scopes/types.ts";
import type { ProductEntry } from "./types.ts";

/**
 * One line of the material list. There is deliberately no price, cost or margin field here, so a crew leader's
 * or supplier's copy can never leak money.
 */
export type MaterialLine = { description: string; unit: string; color: string | null; quantity: number; specialOrder: boolean };
export type MaterialSection = { division: Division; packageTitle: string; lines: MaterialLine[] };
export type MaterialList = { sections: MaterialSection[]; missingColors: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The material list for a job: from each trade's chosen package, material lines only (labor and other costs
 * are left out), grouped by product and color within the trade, quantities added up.
 */
export function buildMaterialList(chosen: StoredScope[], products: ProductEntry[], onlyDivisions?: readonly Division[]): MaterialList {
  const byId = new Map(products.map((p) => [p.id, p]));
  const sections: MaterialSection[] = [];
  let missingColors = 0;
  for (const scope of chosen) {
    if (onlyDivisions && !onlyDivisions.includes(scope.division)) continue;
    const grouped = new Map<string, MaterialLine>();
    for (const item of scope.items) {
      if (item.kind !== "material" || !item.productId) continue;
      const p = byId.get(item.productId);
      const color = item.color?.trim() || null;
      const key = `${item.productId}|${color ?? ""}`;
      const existing = grouped.get(key);
      if (existing) existing.quantity = round2(existing.quantity + item.quantity);
      else grouped.set(key, { description: item.description, unit: p?.unit ?? "ea", color, quantity: round2(item.quantity), specialOrder: p?.specialOrder ?? false });
    }
    const lines = [...grouped.values()].sort((a, b) => a.description.localeCompare(b.description) || (a.color ?? "").localeCompare(b.color ?? ""));
    missingColors += lines.filter((l) => l.color === null).length;
    sections.push({ division: scope.division, packageTitle: scope.title, lines });
  }
  return { sections, missingColors };
}

/** The list as a plain table, so the screen and the CSV download share one shape (no money columns). */
export function materialTable(list: MaterialList, tradeLabel: (d: string) => string): ReportTable {
  return {
    name: "materials", title: "Material list",
    columns: [
      { key: "trade", label: "Trade", kind: "text" }, { key: "item", label: "Item", kind: "text" }, { key: "color", label: "Color", kind: "text" },
      { key: "quantity", label: "Quantity", kind: "int" }, { key: "unit", label: "Unit", kind: "text" }, { key: "special", label: "Special order", kind: "text" },
    ],
    rows: list.sections.flatMap((s) => s.lines.map((l) => ({
      trade: tradeLabel(s.division), item: l.description, color: l.color, quantity: l.quantity, unit: l.unit, special: l.specialOrder ? "Yes" : "",
    }))),
  };
}
