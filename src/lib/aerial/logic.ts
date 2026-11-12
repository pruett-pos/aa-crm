import {
  GoogleSolarError, isTransient, type GeocodeResult, type GoogleErrorKind, type GoogleSolarClient, type SolarBuilding,
} from "../../integrations/google-solar/client.ts";
import { buildRoofingTiers, type AssemblyLine } from "../estimating/assemblies.ts";
import type { Measurements } from "../measurements/types.ts";
import { logError, logInfo } from "../ops/log.ts";
import { SCOPE_DEFAULT_TARGET_MARGIN_BPS } from "../rules.ts";
import { ScopeInputError, computeScope } from "../scopes/service.ts";
import type { Product, Tier } from "../scopes/types.ts";
import type {
  AerialEstimate, AerialNumbers, AerialSegment, AerialSettings, AerialStore, CalibrationSource, Confidence,
} from "./types.ts";

/**
 * Aerial roof estimate: a first look at a roof from Google's imagery, fetched when a Free Inspection is booked.
 * It is for the estimator's eyes before the visit ("verify on site"). It is stored on the PROPERTY, in its own table,
 * and nothing here writes job measurements or scopes: contracts and material orders still come only from Hover or
 * typed-in measurements.
 *
 * These are quantities and conversions, not money. The ballpark prices come from the same computeScope and rules.ts
 * as a real scope of work.
 */

export const SQFT_PER_M2 = 10.7639104;
/** The first try plus at most this many retries, for the whole estimate. */
export const MAX_RETRIES = 2;
const RETRY_WAIT_MS = [1500, 5000];
const STALE_PENDING_MS = 10 * 60_000;
const MAX_ROOF_AREA_SQFT = 200_000;
const MAX_SEGMENTS = 200;
/** How far the building Google found may be from the geocoded point: tight when Google placed the address on a roof. */
const MAX_DISTANCE_M = { rooftop: 60, approximate: 200 };

export const DEFAULT_SETTINGS: AerialSettings = {
  enabled: false,
  wasteBps: 1000,
  correctionBps: 10_000,
  // RULES OF THUMB, not A&A's numbers (a plain gable roof is about 5 ft of eave, 4 of rake and 2.5 of ridge per square).
  // The admin replaces them in Settings; the calibration report shows the real averages from Hover jobs.
  eavesFt10PerSq: 50,
  rakesFt10PerSq: 40,
  ridgesHipsFt10PerSq: 25,
  valleysFt10PerSq: 10,
};

export type AerialErrorCode = "invalid_settings" | "not_found" | "forbidden";
export class AerialError extends Error {
  code: AerialErrorCode;
  constructor(code: AerialErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

// ---------- Conversions ----------
/** Roof pitch as rise over 12 from the slope in degrees: 26.57 degrees is 6/12. Rounded to a whole rise, 0 to 24. */
export function pitchFromDegrees(degrees: number): string {
  if (!Number.isFinite(degrees) || degrees <= 0) return "0/12";
  const rise = Math.round(12 * Math.tan((Math.min(degrees, 89) * Math.PI) / 180));
  return `${Math.min(24, rise)}/12`;
}

export const sqftFromM2 = (m2: number) => Math.round(m2 * SQFT_PER_M2);
/** Square feet to roofing squares in tenths (1 square = 100 sq ft): 2,437 sq ft is 244, shown as 24.4. */
export const squaresX10 = (areaSqft: number) => Math.round(areaSqft / 10);
export const applyCorrection = (rawAreaSqft: number, correctionBps: number) => Math.round((rawAreaSqft * correctionBps) / 10_000);

export function confidenceFor(imageryQuality: string, addressExact: boolean): Confidence {
  if (!addressExact) return "low";
  return imageryQuality === "HIGH" ? "high" : imageryQuality === "MEDIUM" ? "medium" : "low";
}

function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export type NoDataReason = "address_not_found" | "address_imprecise" | "no_building" | "no_roof_area" | "too_far";
const NO_DATA_TEXT: Record<NoDataReason, string> = {
  address_not_found: "Google could not find this address",
  address_imprecise: "Google could only place this address approximately",
  no_building: "Google has no roof data for this address",
  no_roof_area: "Google's roof data for this address has no usable area",
  too_far: "The closest building Google found is too far from this address",
};
const ERROR_TEXT: Record<GoogleErrorKind, string> = {
  auth: "Google rejected the API key", rate_limited: "Google is limiting requests", not_found: "Google has no data",
  bad_request: "Google rejected the request", server: "Google had a problem", network: "Could not reach Google",
};

/** Turn Google's building into the numbers we store, or say why it can't be used. Applies the correction factor. */
export function summarize(
  building: SolarBuilding, geo: GeocodeResult, correctionBps: number,
): { ok: true; numbers: AerialNumbers } | { ok: false; reason: NoDataReason } {
  const rooftop = geo.locationType === "ROOFTOP";
  if (building.center) {
    const limit = rooftop ? MAX_DISTANCE_M.rooftop : MAX_DISTANCE_M.approximate;
    if (distanceMeters(geo, building.center) > limit) return { ok: false, reason: "too_far" };
  }
  const segmentM2 = building.segments.reduce((s, x) => s + x.areaM2, 0);
  const m2 = building.wholeRoofAreaM2 !== null && building.wholeRoofAreaM2 > 0 ? building.wholeRoofAreaM2 : segmentM2;
  const rawAreaSqft = sqftFromM2(m2);
  if (!(rawAreaSqft > 0) || rawAreaSqft > MAX_ROOF_AREA_SQFT) return { ok: false, reason: "no_roof_area" };

  const segments: AerialSegment[] = [...building.segments]
    .sort((a, b) => b.areaM2 - a.areaM2)
    .slice(0, MAX_SEGMENTS)
    .map((s) => ({
      areaSqft: sqftFromM2(s.areaM2), pitch: pitchFromDegrees(s.pitchDegrees), pitchDegrees: Math.round(s.pitchDegrees * 10) / 10,
      azimuthDegrees: s.azimuthDegrees === null ? null : Math.round(s.azimuthDegrees),
    }));
  const byPitch = new Map<string, number>();
  for (const s of segments) byPitch.set(s.pitch, (byPitch.get(s.pitch) ?? 0) + s.areaSqft);
  const mainPitch = [...byPitch.entries()].sort((a, b) => b[1] - a[1] || parseInt(a[0], 10) - parseInt(b[0], 10))[0]?.[0] ?? null;

  const roofAreaSqft = applyCorrection(rawAreaSqft, correctionBps);
  const center = building.center ?? geo;
  return {
    ok: true,
    numbers: {
      lat: center.lat, lng: center.lng, rawAreaSqft, correctionBps, roofAreaSqft, squaresX10: squaresX10(roofAreaSqft),
      mainPitch, segmentCount: building.segments.length, segments,
      imageryQuality: building.imageryQuality, imageryDate: building.imageryDate,
      confidence: confidenceFor(building.imageryQuality, rooftop && !geo.partialMatch),
    },
  };
}

// ---------- Fetching ----------
export type FetchResult =
  | { status: "ok"; attempts: number; hasImage: boolean }
  | { status: "no_data"; reason: NoDataReason; attempts: number }
  | { status: "error"; kind: GoogleErrorKind; attempts: number }
  | { status: "skipped"; reason: "disabled" | "not_configured" | "not_found" | "condition_report" | "no_appointment" | "already_has_one" };

export type FetchDeps = {
  store: AerialStore;
  client: GoogleSolarClient | null;
  now?: () => Date;
  /** Waits between retries. Tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Fetch the aerial estimate for the property of a job that was just booked. Called in the background after the lead
 * is saved. NEVER THROWS: Google being slow, down or empty must never break or slow a booking. Skips when the feature
 * is off, the job is a paid Condition Report, no appointment was booked, or the property already has an estimate.
 * A failed call is retried at most twice over the whole estimate; "not found" is never retried.
 *
 * `force` is the admin's "Fetch again": it ignores the appointment and an earlier result, nothing else.
 */
export async function fetchEstimateForJob(deps: FetchDeps, jobId: string, opts: { force?: boolean } = {}): Promise<FetchResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let propertyId: string | null = null;
  let claimed = false;
  let retries = 0;
  try {
    const settings = await deps.store.getSettings();
    if (!settings.enabled) return { status: "skipped", reason: "disabled" };
    const client = deps.client;
    if (!client) return { status: "skipped", reason: "not_configured" };
    const job = await deps.store.getJob(jobId);
    if (!job) return { status: "skipped", reason: "not_found" };
    if (job.jobType === "condition_report") return { status: "skipped", reason: "condition_report" };
    if (!opts.force && !job.appointmentAt) return { status: "skipped", reason: "no_appointment" };
    propertyId = job.propertyId;
    const at = now();
    claimed = await deps.store.claim(propertyId, at, { staleBefore: new Date(at.getTime() - STALE_PENDING_MS), force: opts.force ?? false });
    if (!claimed) return { status: "skipped", reason: "already_has_one" };

    /** Runs one Google call, trying again on a passing failure while the estimate still has retries left. */
    const withRetry = async <T>(run: () => Promise<T>): Promise<T> => {
      for (;;) {
        try {
          return await run();
        } catch (e) {
          if (!(e instanceof GoogleSolarError) || !isTransient(e.kind) || retries >= MAX_RETRIES) throw e;
          await sleep(RETRY_WAIT_MS[retries] ?? RETRY_WAIT_MS[RETRY_WAIT_MS.length - 1]);
          retries += 1;
        }
      }
    };
    const noData = async (reason: NoDataReason): Promise<FetchResult> => {
      await deps.store.saveFailure(job.propertyId, { status: "no_data", error: NO_DATA_TEXT[reason], attempts: retries + 1 });
      logInfo("aerial.no_data", { jobId, reason, attempts: retries + 1 });
      return { status: "no_data", reason, attempts: retries + 1 };
    };

    let geo: GeocodeResult;
    try {
      geo = await withRetry(() => client.geocode(`${job.street}, ${job.city}, ${job.state} ${job.zip}`));
    } catch (e) {
      if (e instanceof GoogleSolarError && e.kind === "not_found") return await noData("address_not_found");
      throw e;
    }
    // The middle of a street or a town is not this house: the closest building there would be someone else's.
    if (geo.locationType !== "ROOFTOP" && geo.locationType !== "RANGE_INTERPOLATED") return await noData("address_imprecise");

    let building: SolarBuilding;
    try {
      building = await withRetry(() => client.findBuilding(geo.lat, geo.lng));
    } catch (e) {
      if (e instanceof GoogleSolarError && e.kind === "not_found") return await noData("no_building");
      throw e;
    }
    const summary = summarize(building, geo, settings.correctionBps);
    if (!summary.ok) return await noData(summary.reason);

    // The picture is a nice-to-have: without it the numbers are still saved.
    let image: { data: Uint8Array; mime: string } | null = null;
    try {
      image = await withRetry(() => client.satelliteImage(summary.numbers.lat, summary.numbers.lng));
    } catch (e) {
      logError("aerial.image_failed", e, { jobId });
    }
    await deps.store.saveOk(job.propertyId, { numbers: summary.numbers, raw: building.raw, image, attempts: retries + 1, fetchedAt: now() });
    logInfo("aerial.fetched", { jobId, quality: summary.numbers.imageryQuality, segments: summary.numbers.segmentCount, attempts: retries + 1, image: image !== null });
    return { status: "ok", attempts: retries + 1, hasImage: image !== null };
  } catch (e) {
    const kind: GoogleErrorKind = e instanceof GoogleSolarError ? e.kind : "server";
    logError("aerial.failed", e, { jobId, kind, attempts: retries + 1 });
    if (claimed && propertyId) {
      await deps.store.saveFailure(propertyId, { status: "error", error: ERROR_TEXT[kind], attempts: retries + 1 }).catch(() => undefined);
    }
    return { status: "error", kind, attempts: retries + 1 };
  }
}

// ---------- Settings ----------
export type SettingsInput = {
  enabled: boolean; wastePct: number; correctionPct: number;
  eavesFtPerSq: number; rakesFtPerSq: number; ridgesHipsFtPerSq: number; valleysFtPerSq: number;
};

export const CORRECTION_MIN_BPS = 5000;
export const CORRECTION_MAX_BPS = 15_000;
const MAX_FT10_PER_SQ = 500;

/** Check the admin's settings and turn percents into basis points and feet into tenths. */
export function validateSettings(i: SettingsInput): AerialSettings {
  const bad = (m: string): never => { throw new AerialError("invalid_settings", m); };
  const fin = (n: number) => typeof n === "number" && Number.isFinite(n);
  if (typeof i.enabled !== "boolean") bad("Choose on or off");
  if (!fin(i.wastePct) || i.wastePct < 0 || i.wastePct > 30) bad("Waste must be between 0% and 30%");
  const correctionBps = fin(i.correctionPct) ? Math.round(i.correctionPct * 100) : NaN;
  if (!(correctionBps >= CORRECTION_MIN_BPS && correctionBps <= CORRECTION_MAX_BPS)) bad("The correction factor must be between 50% and 150%");
  const len = (label: string, ft: number) => {
    const t = fin(ft) ? Math.round(ft * 10) : NaN;
    if (!(t >= 0 && t <= MAX_FT10_PER_SQ)) bad(`${label} must be between 0 and 50 ft per square`);
    return t;
  };
  return {
    enabled: i.enabled, wasteBps: Math.round(i.wastePct * 100), correctionBps,
    eavesFt10PerSq: len("Eaves", i.eavesFtPerSq), rakesFt10PerSq: len("Rakes", i.rakesFtPerSq),
    ridgesHipsFt10PerSq: len("Ridges and hips", i.ridgesHipsFtPerSq), valleysFt10PerSq: len("Valleys", i.valleysFtPerSq),
  };
}

// ---------- Ballpark price ----------
type Priced = Pick<AerialNumbers, "roofAreaSqft" | "rawAreaSqft" | "segments" | "segmentCount">;

/**
 * The aerial estimate as a set of measurements the roofing takeoff understands. Google gives no edge lengths, so the
 * eaves, rakes, ridges and valleys are the admin's average feet per square times the roof's squares. ONLY for the
 * ballpark: this is never saved as a job's measurements.
 */
export function aerialMeasurements(e: Priced, s: AerialSettings): Measurements {
  const sq = e.roofAreaSqft / 100;
  const scale = e.rawAreaSqft > 0 ? e.roofAreaSqft / e.rawAreaSqft : 1;
  const byPitch = new Map<string, number>();
  for (const seg of e.segments) byPitch.set(seg.pitch, (byPitch.get(seg.pitch) ?? 0) + seg.areaSqft * scale);
  const ft = (ft10PerSq: number) => Math.round(sq * ft10PerSq) / 10;
  return {
    roofAreaSqft: e.roofAreaSqft, facets: e.segmentCount,
    pitches: [...byPitch.entries()].map(([pitch, area]) => ({ pitch, areaSqft: Math.round(area), percent: null })),
    ridgesHipsFt: ft(s.ridgesHipsFt10PerSq), valleysFt: ft(s.valleysFt10PerSq), rakesFt: ft(s.rakesFt10PerSq), eavesFt: ft(s.eavesFt10PerSq),
    flashingFt: 0, stepFlashingFt: 0, sidingAreaSqft: null,
  };
}

export type Ballpark = {
  wastePct: number;
  tiers: { tier: Tier; saleCents: number }[];
  lowCents: number;
  highCents: number;
};

/**
 * Good / Better / Best customer prices for this roof from the existing roofing assembly templates and today's price
 * book, through computeScope (so the pricing rules are the same as a real scope of work). Null when the templates
 * can't price anything. Computed when the page opens and never stored: it must not reach a contract or a material order.
 */
export function ballpark(a: { estimate: Priced; settings: AerialSettings; lines: AssemblyLine[]; products: Product[] }): Ballpark | null {
  if (!(a.estimate.roofAreaSqft > 0)) return null;
  const wastePct = a.settings.wasteBps / 100;
  const products = a.products.filter((p) => p.active !== false);
  const { tiers } = buildRoofingTiers({ measurements: aerialMeasurements(a.estimate, a.settings), wastePct, lines: a.lines, products });
  const priced: Ballpark["tiers"] = [];
  for (const t of tiers) {
    try {
      const scope = computeScope({ division: "roofing", tier: t.tier, title: t.title, targetMarginBps: SCOPE_DEFAULT_TARGET_MARGIN_BPS, items: t.items }, products, ["roofing"]);
      if (scope.saleCents > 0) priced.push({ tier: t.tier, saleCents: scope.saleCents });
    } catch (e) {
      if (!(e instanceof ScopeInputError)) throw e;
    }
  }
  if (priced.length === 0) return null;
  const amounts = priced.map((p) => p.saleCents);
  return { wastePct, tiers: priced, lowCents: Math.min(...amounts), highCents: Math.max(...amounts) };
}

// ---------- Calibration ----------
export type CalibrationRow = { jobId: string; jobNumber: number; street: string; aerialSquaresX10: number; hoverSquaresX10: number; diffBps: number };
export type Calibration = {
  rows: CalibrationRow[];
  /** Average of the signed differences: above zero means the aerial estimate runs big. */
  avgDiffBps: number | null;
  /** Average size of the miss, ignoring direction. */
  avgAbsDiffBps: number | null;
  /** Total Hover area over total aerial area: the factor that would have made the totals match. */
  suggestedCorrectionBps: number | null;
  /** What Hover measured on these roofs, in tenths of a foot per square: a guide for the edge-length settings. */
  hoverFt10PerSq: { eaves: number; rakes: number; ridgesHips: number; valleys: number } | null;
};

/** Aerial vs Hover, always on Google's UNCORRECTED area so a factor already in force is not counted twice. */
export function calibration(sources: CalibrationSource[]): Calibration {
  const usable = sources.filter((s) => s.hoverSqft > 0 && s.aerialRawSqft > 0);
  const rows = usable.map((s) => ({
    jobId: s.jobId, jobNumber: s.jobNumber, street: s.street, aerialSquaresX10: squaresX10(s.aerialRawSqft), hoverSquaresX10: squaresX10(s.hoverSqft),
    diffBps: Math.round(((s.aerialRawSqft - s.hoverSqft) / s.hoverSqft) * 10_000),
  }));
  if (rows.length === 0) return { rows, avgDiffBps: null, avgAbsDiffBps: null, suggestedCorrectionBps: null, hoverFt10PerSq: null };
  const sum = (f: (s: CalibrationSource) => number) => usable.reduce((t, s) => t + f(s), 0);
  const aerial = sum((s) => s.aerialRawSqft), hover = sum((s) => s.hoverSqft);
  const perSq = (f: (s: CalibrationSource) => number) => Math.round((sum(f) / (hover / 100)) * 10);
  return {
    rows,
    avgDiffBps: Math.round(rows.reduce((t, r) => t + r.diffBps, 0) / rows.length),
    avgAbsDiffBps: Math.round(rows.reduce((t, r) => t + Math.abs(r.diffBps), 0) / rows.length),
    suggestedCorrectionBps: Math.min(CORRECTION_MAX_BPS, Math.max(CORRECTION_MIN_BPS, Math.round((hover / aerial) * 10_000))),
    hoverFt10PerSq: {
      eaves: perSq((s) => s.hoverEavesFt), rakes: perSq((s) => s.hoverRakesFt), ridgesHips: perSq((s) => s.hoverRidgesHipsFt), valleys: perSq((s) => s.hoverValleysFt),
    },
  };
}

// ---------- What a screen shows ----------
export type AerialPanelView = {
  propertyId: string;
  /** off = the feature is switched off and this property has nothing saved. */
  state: "off" | "none" | "pending" | "ok" | "no_data";
  estimate: AerialEstimate | null;
  ballpark: Ballpark | null;
};

/** `no_data` and `error` both read "No aerial data" on screen; the reason is kept for the admin. */
export function panelState(estimate: AerialEstimate | null, enabled: boolean): AerialPanelView["state"] {
  if (!estimate) return enabled ? "none" : "off";
  return estimate.status === "ok" ? "ok" : estimate.status === "pending" ? "pending" : "no_data";
}
