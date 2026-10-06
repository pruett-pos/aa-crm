import { squares, squaresWithWaste } from "../measurements/parse.ts";
import type { Measurements } from "../measurements/types.ts";

/**
 * Roofing takeoff: from a roof's measurements to the quantities to order and to do.
 * These are quantities, not money (prices come from the catalog and the margin rules when the scope is computed),
 * so they live here and not in rules.ts. Every formula and every coverage figure is in this one file.
 *
 * The coverage numbers are COMMON RULES OF THUMB, not A&A's own. An admin sets the real ones per package in the
 * assembly settings; a blank coverage there falls back to these.
 */

export const MATERIAL_ROLES = ["shingles", "starter", "ridge_cap", "underlayment", "ice_water", "drip_edge", "nails"] as const;
export type MaterialRole = (typeof MATERIAL_ROLES)[number];
export const LABOR_ROLES = ["tear_off", "install_shingles", "ridge_cap_labor", "valley_labor", "steep_labor"] as const;
export type LaborRole = (typeof LABOR_ROLES)[number];
export type RoofingRole = MaterialRole | LaborRole;

export const isMaterialRole = (r: string): r is MaterialRole => (MATERIAL_ROLES as readonly string[]).includes(r);
export const isLaborRole = (r: string): r is LaborRole => (LABOR_ROLES as readonly string[]).includes(r);

/** What each material role is measured against, in plain words (shown in settings). */
export const MATERIAL_BASIS: Record<MaterialRole, { basis: string; per: string; defaultCoverage: number }> = {
  shingles:     { basis: "roofing squares with waste", per: "square", defaultCoverage: 1 },
  starter:      { basis: "eaves + rakes (ft)", per: "bundle (ft)", defaultCoverage: 105 },
  ridge_cap:    { basis: "ridges + hips (ft)", per: "bundle (ft)", defaultCoverage: 33 },
  underlayment: { basis: "roofing squares with waste", per: "roll (squares)", defaultCoverage: 10 },
  ice_water:    { basis: "3 ft along eaves and valleys (sq ft)", per: "roll (sq ft)", defaultCoverage: 200 },
  drip_edge:    { basis: "eaves + rakes (ft)", per: "piece (ft)", defaultCoverage: 10 },
  nails:        { basis: "roofing squares with waste", per: "box (squares)", defaultCoverage: 1.5 },
};

export const LABOR_BASIS: Record<LaborRole, { basis: string; unit: "sq" | "lf"; label: string }> = {
  tear_off:         { basis: "roofing squares", unit: "sq", label: "Tear off existing roof" },
  install_shingles: { basis: "roofing squares", unit: "sq", label: "Install shingles" },
  ridge_cap_labor:  { basis: "ridges + hips (ft)", unit: "lf", label: "Install ridge and hip cap" },
  valley_labor:     { basis: "valleys (ft)", unit: "lf", label: "Install valleys" },
  steep_labor:      { basis: "squares at 8/12 or steeper", unit: "sq", label: "Steep roof labor" },
};

/** Roofs at or above this rise per 12 are "steep" and get the steep labor line. */
export const STEEP_PITCH_MIN = 8;
/** Width of ice and water shield along eaves and in valleys, in feet. */
export const ICE_WATER_WIDTH_FT = 3;

export type Basis = {
  squares: number;            // measured roof squares, no waste
  wasteSquares: number;       // with the waste allowance
  eavesRakesFt: number;
  ridgeHipFt: number;
  valleyFt: number;
  iceWaterSqft: number;
  steepSquares: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Rise per 12 from "8/12" or "6.5/12". */
export const pitchRise = (pitch: string): number | null => {
  const head = pitch.split("/")[0].trim();
  const n = head === "" ? NaN : Number(head);
  return Number.isFinite(n) ? n : null;
};

/** The numbers every roofing quantity is worked out from. */
export function takeoffBasis(m: Measurements, wastePct: number): Basis {
  const steepArea = m.pitches.filter((p) => (pitchRise(p.pitch) ?? 0) >= STEEP_PITCH_MIN).reduce((s, p) => s + p.areaSqft, 0);
  return {
    squares: squares(m.roofAreaSqft),
    wasteSquares: squaresWithWaste(m.roofAreaSqft, wastePct),
    eavesRakesFt: round2(m.eavesFt + m.rakesFt),
    ridgeHipFt: m.ridgesHipsFt,
    valleyFt: m.valleysFt,
    iceWaterSqft: round2((m.eavesFt + m.valleysFt) * ICE_WATER_WIDTH_FT),
    steepSquares: squares(steepArea),
  };
}

const MATERIAL_INPUT: Record<MaterialRole, (b: Basis) => number> = {
  shingles: (b) => b.wasteSquares, starter: (b) => b.eavesRakesFt, ridge_cap: (b) => b.ridgeHipFt, underlayment: (b) => b.wasteSquares,
  ice_water: (b) => b.iceWaterSqft, drip_edge: (b) => b.eavesRakesFt, nails: (b) => b.wasteSquares,
};

/** Whole units to buy: the basis divided by what one unit covers, rounded UP (you can't buy part of a bundle). */
export function materialQuantity(role: MaterialRole, b: Basis, coverage: number | null | undefined): number {
  const per = coverage && coverage > 0 ? coverage : MATERIAL_BASIS[role].defaultCoverage;
  const need = MATERIAL_INPUT[role](b);
  if (need <= 0) return 0;
  return Math.ceil(Math.round((need / per) * 1000) / 1000);          // the inner round stops 105/105 from becoming 2
}

const LABOR_INPUT: Record<LaborRole, (b: Basis) => number> = {
  tear_off: (b) => b.squares, install_shingles: (b) => b.squares, ridge_cap_labor: (b) => b.ridgeHipFt, valley_labor: (b) => b.valleyFt, steep_labor: (b) => b.steepSquares,
};

/** Labor is paid on what is measured: squares to two decimals, linear feet rounded up to a whole foot. */
export function laborQuantity(role: LaborRole, b: Basis): number {
  const n = LABOR_INPUT[role](b);
  if (n <= 0) return 0;
  return LABOR_BASIS[role].unit === "sq" ? round2(n) : Math.ceil(Math.round(n * 10) / 10);
}
