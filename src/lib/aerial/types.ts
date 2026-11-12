import type { Division } from "../rules.ts";

/** ok = numbers saved; no_data = Google has nothing usable for this address; error = Google could not be reached. */
export type AerialStatus = "pending" | "ok" | "no_data" | "error";
export type Confidence = "high" | "medium" | "low";

/** One plane of the roof as Google measured it (before any correction factor). */
export type AerialSegment = { areaSqft: number; pitch: string; pitchDegrees: number; azimuthDegrees: number | null };

/** The numbers saved when an estimate succeeds. */
export type AerialNumbers = {
  lat: number;
  lng: number;
  /** Roof area exactly as Google measured it, whole square feet. */
  rawAreaSqft: number;
  /** The correction factor that was in force when this was fetched (10000 = none). */
  correctionBps: number;
  /** Raw area times the correction factor. This is the area the squares and the ballpark use. */
  roofAreaSqft: number;
  /** Roofing squares (1 square = 100 sq ft) in tenths: 243 means 24.3 squares. */
  squaresX10: number;
  /** The pitch that covers the most roof, like "6/12". */
  mainPitch: string | null;
  segmentCount: number;
  segments: AerialSegment[];
  imageryQuality: string;
  /** YYYY-MM-DD */
  imageryDate: string | null;
  confidence: Confidence;
};

export type AerialEstimate = {
  propertyId: string;
  status: AerialStatus;
  /** How many times Google was asked for this estimate (first try plus retries). */
  attempts: number;
  /** A short fixed reason when status is no_data or error. Never anything from Google's response. */
  error: string | null;
  hasImage: boolean;
  fetchedAt: Date | null;
  updatedAt: Date;
} & Partial<AerialNumbers>;

/** Admin settings (one row). Percentages are basis points; lengths are tenths of a foot. */
export type AerialSettings = {
  enabled: boolean;
  /** Waste added to the squares for the ballpark price. */
  wasteBps: number;
  /** Multiplies Google's roof area on future estimates. 10000 = no change. */
  correctionBps: number;
  /**
   * Google measures area and pitch but no edges. These average lengths per roofing square stand in for the eaves,
   * rakes, ridges and hips, and valleys so the ballpark includes edge and ridge materials.
   */
  eavesFt10PerSq: number;
  rakesFt10PerSq: number;
  ridgesHipsFt10PerSq: number;
  valleysFt10PerSq: number;
};

export type AerialJob = {
  id: string;
  jobNumber: number;
  jobType: "retail" | "insurance" | "condition_report";
  stage: string;
  divisions: Division[];
  appointmentAt: Date | null;
  estimatorName: string | null;
  propertyId: string;
  street: string;
  city: string;
  state: string;
  zip: string;
};

/** A property that has both an aerial estimate and a Hover measurement (its newest one). */
export type CalibrationSource = {
  jobId: string;
  jobNumber: number;
  street: string;
  aerialRawSqft: number;
  hoverSqft: number;
  hoverEavesFt: number;
  hoverRakesFt: number;
  hoverRidgesHipsFt: number;
  hoverValleysFt: number;
};

export interface AerialStore {
  getSettings(): Promise<AerialSettings>;
  saveSettings(s: AerialSettings, userId: string): Promise<void>;
  getJob(jobId: string): Promise<AerialJob | null>;
  getEstimate(propertyId: string): Promise<AerialEstimate | null>;
  /**
   * Take the right to fetch this property's estimate. True when there was no estimate yet (a `pending` row is created),
   * when an earlier fetch was left `pending` before `staleBefore` (the server stopped mid-fetch), or with `force`
   * (an admin asked again). False when the property already has one. Atomic: two bookings at once make one fetch.
   */
  claim(propertyId: string, now: Date, opts: { staleBefore: Date; force: boolean }): Promise<boolean>;
  saveOk(propertyId: string, a: { numbers: AerialNumbers; raw: unknown; image: { data: Uint8Array; mime: string } | null; attempts: number; fetchedAt: Date }): Promise<void>;
  saveFailure(propertyId: string, a: { status: "no_data" | "error"; error: string; attempts: number; raw?: unknown }): Promise<void>;
  getImage(propertyId: string): Promise<{ data: Uint8Array; mime: string } | null>;
  calibrationSources(): Promise<CalibrationSource[]>;
}
