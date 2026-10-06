import type { Measurements } from "./types.ts";

export type MeasurementErrorCode =
  | "not_found" | "forbidden" | "locked" | "hover_not_connected" | "hover_error" | "search_too_short" | "no_match" | "model_not_ready"
  | "no_roof_data" | "no_roof_area" | "invalid_value";

export class MeasurementError extends Error {
  code: MeasurementErrorCode;
  /** For invalid_value: which field. */
  field: string | null;
  constructor(code: MeasurementErrorCode, message?: string, field: string | null = null) {
    super(message ?? code);
    this.code = code;
    this.field = field;
  }
}

// Sanity limits. A roof bigger than this is a typo or a bad model, never a real house.
export const MAX_ROOF_AREA_SQFT = 200_000;
export const MAX_SIDING_AREA_SQFT = 500_000;
export const MAX_LENGTH_FT = 500_000;
export const MAX_PITCHES = 12;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Square feet to roofing squares (1 square = 100 sq ft), to two decimals. */
export const squares = (areaSqft: number) => Math.round(areaSqft) / 100;
/** Squares to order with a waste allowance: area + waste %, to two decimals. */
export const squaresWithWaste = (areaSqft: number, wastePct: number) => Math.round(areaSqft * (1 + wastePct / 100)) / 100;

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A number from a number or a numeric string; null for anything else (never NaN, never Infinity). */
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Hover sends each total as an object ({ area, total } or { length, total }); read it defensively in case a response comes
 * as a list of pieces instead, by adding the pieces up. Missing means null.
 */
function pick(node: any, key: string): number | null {
  if (typeof node === "number" || typeof node === "string") return num(node);
  if (Array.isArray(node)) {
    const parts = node.map((n) => num(n?.[key])).filter((n): n is number => n !== null);
    return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  }
  return node && typeof node === "object" ? num(node[key]) : null;
}

function checked(field: string, v: number | null, max: number, { allowNull = false } = {}): number | null {
  if (v === null) {
    if (allowNull) return null;
    throw new MeasurementError("invalid_value", `${field} is missing`, field);
  }
  if (v < 0 || v > max) throw new MeasurementError("invalid_value", `${field} is out of range`, field);
  return v;
}

/** Check a set of measurements (from Hover or typed in) and round them to what we store. */
export function validateMeasurements(m: Measurements): Measurements {
  const area = checked("roofAreaSqft", num(m.roofAreaSqft), MAX_ROOF_AREA_SQFT)!;
  if (area <= 0) throw new MeasurementError("no_roof_area", "The roof area must be more than zero", "roofAreaSqft");
  if (!Array.isArray(m.pitches) || m.pitches.length > MAX_PITCHES) throw new MeasurementError("invalid_value", "Too many pitches", "pitches");
  const pitches = m.pitches.map((p, i) => {
    if (typeof p?.pitch !== "string" || !/^\d{1,2}(\.\d{1,2})?\/12$/.test(p.pitch.trim())) throw new MeasurementError("invalid_value", "A pitch looks like 6/12", `pitches.${i}.pitch`);
    return {
      pitch: p.pitch.trim(), areaSqft: Math.round(checked(`pitches.${i}.areaSqft`, num(p.areaSqft), MAX_ROOF_AREA_SQFT)!),
      percent: p.percent === null || p.percent === undefined ? null : round1(checked(`pitches.${i}.percent`, num(p.percent), 100)!),
    };
  });
  const len = (field: string, v: number) => round1(checked(field, num(v), MAX_LENGTH_FT)!);
  const facets = m.facets === null || m.facets === undefined ? null : Math.round(checked("facets", num(m.facets), 5000)!);
  const siding = m.sidingAreaSqft === null || m.sidingAreaSqft === undefined ? null : Math.round(checked("sidingAreaSqft", num(m.sidingAreaSqft), MAX_SIDING_AREA_SQFT)!);
  return {
    roofAreaSqft: Math.round(area), facets, pitches,
    ridgesHipsFt: len("ridgesHipsFt", m.ridgesHipsFt), valleysFt: len("valleysFt", m.valleysFt), rakesFt: len("rakesFt", m.rakesFt),
    eavesFt: len("eavesFt", m.eavesFt), flashingFt: len("flashingFt", m.flashingFt), stepFlashingFt: len("stepFlashingFt", m.stepFlashingFt),
    sidingAreaSqft: siding,
  };
}

/**
 * Read Hover's measurements JSON (full_json). A roof total is required; every other piece is optional and counts as zero
 * when Hover leaves it out (a flat addition has no ridge, say). Anything out of range is refused.
 */
export function parseHoverMeasurements(raw: unknown): Measurements {
  const j = raw as any;
  const roof = j && typeof j === "object" ? j.roof : null;
  if (!roof || typeof roof !== "object") throw new MeasurementError("no_roof_data", "Hover's measurements have no roof data");
  const area = pick(roof.roof_facets, "area");
  if (area === null || area <= 0) throw new MeasurementError("no_roof_area", "Hover's measurements have no roof area");
  const len = (node: unknown) => pick(node, "length") ?? 0;
  const pitches = (Array.isArray(roof.pitch) ? roof.pitch : []).flatMap((p: any) => {
    const pitch = typeof p?.roof_pitch === "string" ? p.roof_pitch.trim() : "";
    const a = num(p?.area);
    return pitch && a !== null ? [{ pitch, areaSqft: a, percent: num(p?.percentage) }] : [];
  });
  return validateMeasurements({
    roofAreaSqft: area, facets: pick(roof.roof_facets, "total"), pitches,
    ridgesHipsFt: len(roof.ridges_hips), valleysFt: len(roof.valleys), rakesFt: len(roof.rakes),
    eavesFt: len(roof.gutters_eaves), flashingFt: len(roof.flashing), stepFlashingFt: len(roof.step_flashing),
    sidingAreaSqft: pick(j?.area?.total, "siding"),
  });
}
