import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { JobStageOrClosed } from "../production/types.ts";
import type { Division } from "../rules.ts";
import type { MeasurementJob, MeasurementRecord, MeasurementSource, MeasurementStore, NewMeasurement } from "./types.ts";

const UUID = /^[0-9a-f-]{36}$/i;
const ft = (tenths: number) => tenths / 10;
const tenths = (feet: number) => Math.round(feet * 10);

type Row = {
  id: string; jobId: string; source: string; hoverJobId: string | null; hoverModelId: string | null; roofAreaSqft: number; facets: number | null;
  pitches: unknown; ridgesHipsFt10: number; valleysFt10: number; rakesFt10: number; eavesFt10: number; flashingFt10: number; stepFlashingFt10: number;
  sidingAreaSqft: number | null; note: string | null; createdBy: string | null; createdAt: Date;
};
const toRecord = (r: Row): MeasurementRecord => ({
  id: r.id, jobId: r.jobId, source: r.source as MeasurementSource, hoverJobId: r.hoverJobId, hoverModelId: r.hoverModelId,
  roofAreaSqft: r.roofAreaSqft, facets: r.facets, pitches: Array.isArray(r.pitches) ? (r.pitches as MeasurementRecord["pitches"]) : [],
  ridgesHipsFt: ft(r.ridgesHipsFt10), valleysFt: ft(r.valleysFt10), rakesFt: ft(r.rakesFt10), eavesFt: ft(r.eavesFt10),
  flashingFt: ft(r.flashingFt10), stepFlashingFt: ft(r.stepFlashingFt10), sidingAreaSqft: r.sidingAreaSqft,
  note: r.note, createdBy: r.createdBy, createdAt: r.createdAt,
});

// Everything except the raw Hover JSON, which is kept for the record but never loaded for screens.
const SELECT = {
  id: true, jobId: true, source: true, hoverJobId: true, hoverModelId: true, roofAreaSqft: true, facets: true, pitches: true,
  ridgesHipsFt10: true, valleysFt10: true, rakesFt10: true, eavesFt10: true, flashingFt10: true, stepFlashingFt10: true,
  sidingAreaSqft: true, note: true, createdBy: true, createdAt: true,
} as const;

export function createPrismaMeasurementStore(db: PrismaClient): MeasurementStore {
  return {
    async getJob(jobId): Promise<MeasurementJob | null> {
      if (!UUID.test(jobId)) return null;
      const j = await db.job.findUnique({ where: { id: jobId }, include: { property: true } });
      if (!j) return null;
      return {
        id: j.id, jobNumber: j.jobNumber, stage: j.stage as JobStageOrClosed, estimatorId: j.estimatorId, divisions: j.divisions as Division[],
        street: j.property.street, city: j.property.city, zip: j.property.zip,
      };
    },
    async pmDivisions(userId) {
      if (!UUID.test(userId)) return [];
      const rows = await db.divisionManager.findMany({ where: { userId } });
      return [...new Set(rows.map((r) => r.division as Division))];
    },
    async list(jobId) {
      if (!UUID.test(jobId)) return [];
      const rows = await db.jobMeasurement.findMany({ where: { jobId }, select: SELECT, orderBy: { createdAt: "desc" } });
      return rows.map(toRecord);
    },
    async insert(jobId, m: NewMeasurement) {
      const row = await db.jobMeasurement.create({
        data: {
          jobId, source: m.source, hoverJobId: m.hoverJobId, hoverModelId: m.hoverModelId, roofAreaSqft: m.roofAreaSqft, facets: m.facets,
          pitches: m.pitches, ridgesHipsFt10: tenths(m.ridgesHipsFt), valleysFt10: tenths(m.valleysFt), rakesFt10: tenths(m.rakesFt),
          eavesFt10: tenths(m.eavesFt), flashingFt10: tenths(m.flashingFt), stepFlashingFt10: tenths(m.stepFlashingFt),
          sidingAreaSqft: m.sidingAreaSqft, raw: (m.raw ?? undefined) as never, note: m.note, createdBy: m.createdBy,
        },
        select: SELECT,
      });
      return toRecord(row);
    },
  };
}
