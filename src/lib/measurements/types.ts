import type { Division } from "../rules.ts";
import type { JobStageOrClosed } from "../production/types.ts";

/** What a roof measures, in plain units: square feet for areas, feet (one decimal) for lengths. */
export type Measurements = {
  roofAreaSqft: number;
  facets: number | null;
  /** Roof area at each pitch, like { pitch: "6/12", areaSqft: 1800, percent: 62.5 }. */
  pitches: { pitch: string; areaSqft: number; percent: number | null }[];
  ridgesHipsFt: number;
  valleysFt: number;
  rakesFt: number;
  eavesFt: number;
  flashingFt: number;
  stepFlashingFt: number;
  /** Siding area from the exterior model, if Hover sent it. */
  sidingAreaSqft: number | null;
};

export type MeasurementSource = "hover" | "manual";

export type MeasurementRecord = Measurements & {
  id: string;
  jobId: string;
  source: MeasurementSource;
  hoverJobId: string | null;
  hoverModelId: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
};

export type NewMeasurement = Measurements & {
  source: MeasurementSource;
  hoverJobId: string | null;
  hoverModelId: string | null;
  raw: unknown | null;
  note: string | null;
  createdBy: string;
};

export type MeasurementJob = {
  id: string;
  jobNumber: number;
  stage: JobStageOrClosed;
  estimatorId: string | null;
  divisions: Division[];
  street: string;
  city: string;
  zip: string;
};

export interface MeasurementStore {
  getJob(jobId: string): Promise<MeasurementJob | null>;
  pmDivisions(userId: string): Promise<Division[]>;
  /** Newest first. */
  list(jobId: string): Promise<MeasurementRecord[]>;
  insert(jobId: string, m: NewMeasurement): Promise<MeasurementRecord>;
}
