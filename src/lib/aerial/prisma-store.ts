import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { Division } from "../rules.ts";
import { DEFAULT_SETTINGS } from "./logic.ts";
import type {
  AerialEstimate, AerialJob, AerialSegment, AerialSettings, AerialStatus, AerialStore, CalibrationSource, Confidence,
} from "./types.ts";

const UUID = /^[0-9a-f-]{36}$/i;

// Everything a screen needs. The raw Google JSON and the picture are never loaded with the row.
const SELECT = {
  propertyId: true, status: true, attempts: true, error: true, lat: true, lng: true, rawAreaSqft: true, correctionBps: true,
  roofAreaSqft: true, squaresX10: true, mainPitch: true, segmentCount: true, segments: true, imageryQuality: true,
  imageryDate: true, confidence: true, imageMime: true, fetchedAt: true, updatedAt: true,
} as const;

export function createPrismaAerialStore(db: PrismaClient): AerialStore {
  return {
    async getSettings(): Promise<AerialSettings> {
      const r = await db.aerialSettings.findUnique({ where: { id: 1 } });
      if (!r) return { ...DEFAULT_SETTINGS };
      return {
        enabled: r.enabled, wasteBps: r.wasteBps, correctionBps: r.correctionBps, eavesFt10PerSq: r.eavesFt10PerSq,
        rakesFt10PerSq: r.rakesFt10PerSq, ridgesHipsFt10PerSq: r.ridgesHipsFt10PerSq, valleysFt10PerSq: r.valleysFt10PerSq,
      };
    },
    async saveSettings(s, userId) {
      const data = { ...s, updatedBy: UUID.test(userId) ? userId : null, updatedAt: new Date() };
      await db.aerialSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    },

    async getJob(jobId): Promise<AerialJob | null> {
      if (!UUID.test(jobId)) return null;
      const j = await db.job.findUnique({ where: { id: jobId }, include: { property: true } });
      if (!j) return null;
      const estimator = j.estimatorId ? await db.user.findUnique({ where: { id: j.estimatorId }, select: { fullName: true } }) : null;
      return {
        id: j.id, jobNumber: j.jobNumber, jobType: j.jobType as AerialJob["jobType"], stage: j.stage, divisions: j.divisions as Division[],
        appointmentAt: j.appointmentAt, estimatorName: estimator?.fullName ?? null, propertyId: j.propertyId,
        street: j.property.street, city: j.property.city, state: j.property.state, zip: j.property.zip,
      };
    },

    async getEstimate(propertyId): Promise<AerialEstimate | null> {
      if (!UUID.test(propertyId)) return null;
      const r = await db.propertyAerialEstimate.findUnique({ where: { propertyId }, select: SELECT });
      if (!r) return null;
      const base = { propertyId: r.propertyId, status: r.status as AerialStatus, attempts: r.attempts, error: r.error, hasImage: r.imageMime !== null, fetchedAt: r.fetchedAt, updatedAt: r.updatedAt };
      if (r.status !== "ok" || r.rawAreaSqft === null || r.roofAreaSqft === null || r.squaresX10 === null || r.lat === null || r.lng === null) return base;
      return {
        ...base, lat: r.lat, lng: r.lng, rawAreaSqft: r.rawAreaSqft, correctionBps: r.correctionBps ?? 10_000, roofAreaSqft: r.roofAreaSqft,
        squaresX10: r.squaresX10, mainPitch: r.mainPitch, segmentCount: r.segmentCount ?? 0,
        segments: Array.isArray(r.segments) ? (r.segments as unknown as AerialSegment[]) : [],
        imageryQuality: r.imageryQuality ?? "", imageryDate: r.imageryDate ? r.imageryDate.toISOString().slice(0, 10) : null,
        confidence: (r.confidence ?? "low") as Confidence,
      };
    },

    async claim(propertyId, now, opts) {
      if (!UUID.test(propertyId)) return false;
      // INSERT ... ON CONFLICT DO NOTHING: of two bookings at once exactly one gets the new row.
      const made = await db.propertyAerialEstimate.createMany({ data: [{ propertyId, status: "pending", updatedAt: now }], skipDuplicates: true });
      if (made.count === 1) return true;
      const taken = await db.propertyAerialEstimate.updateMany({
        where: opts.force
          ? { propertyId, OR: [{ status: { not: "pending" } }, { updatedAt: { lt: opts.staleBefore } }] }
          : { propertyId, status: "pending", updatedAt: { lt: opts.staleBefore } },
        data: { status: "pending", attempts: 0, error: null, updatedAt: now },
      });
      return taken.count === 1;
    },

    async saveOk(propertyId, a) {
      const n = a.numbers;
      await db.propertyAerialEstimate.update({
        where: { propertyId },
        data: {
          status: "ok", attempts: a.attempts, error: null, lat: n.lat, lng: n.lng, rawAreaSqft: n.rawAreaSqft, correctionBps: n.correctionBps,
          roofAreaSqft: n.roofAreaSqft, squaresX10: n.squaresX10, mainPitch: n.mainPitch, segmentCount: n.segmentCount, segments: n.segments,
          imageryQuality: n.imageryQuality, imageryDate: n.imageryDate ? new Date(`${n.imageryDate}T00:00:00Z`) : null, confidence: n.confidence,
          raw: (a.raw ?? undefined) as never, imageData: a.image ? Buffer.from(a.image.data) : null, imageMime: a.image?.mime ?? null,
          fetchedAt: a.fetchedAt, updatedAt: a.fetchedAt,
        },
      });
    },
    async saveFailure(propertyId, a) {
      await db.propertyAerialEstimate.update({
        where: { propertyId }, data: { status: a.status, error: a.error.slice(0, 200), attempts: a.attempts, updatedAt: new Date() },
      });
    },

    async getImage(propertyId) {
      if (!UUID.test(propertyId)) return null;
      const r = await db.propertyAerialEstimate.findUnique({ where: { propertyId }, select: { imageData: true, imageMime: true } });
      return r?.imageData && r.imageMime ? { data: new Uint8Array(r.imageData), mime: r.imageMime } : null;
    },

    async calibrationSources(): Promise<CalibrationSource[]> {
      const estimates = await db.propertyAerialEstimate.findMany({
        where: { status: "ok", rawAreaSqft: { gt: 0 } },
        select: { rawAreaSqft: true, property: { select: { street: true, jobs: { select: { id: true, jobNumber: true } } } } },
      });
      const jobIds = estimates.flatMap((e) => e.property.jobs.map((j) => j.id));
      if (jobIds.length === 0) return [];
      const hover = await db.jobMeasurement.findMany({
        where: { jobId: { in: jobIds }, source: "hover" }, orderBy: { createdAt: "desc" },
        select: { jobId: true, roofAreaSqft: true, eavesFt10: true, rakesFt10: true, ridgesHipsFt10: true, valleysFt10: true },
      });
      const out: CalibrationSource[] = [];
      for (const e of estimates) {
        const jobs = new Map(e.property.jobs.map((j) => [j.id, j.jobNumber]));
        const m = hover.find((h) => jobs.has(h.jobId));          // newest Hover measurement on any of the property's jobs
        if (!m || e.rawAreaSqft === null) continue;
        out.push({
          jobId: m.jobId, jobNumber: jobs.get(m.jobId)!, street: e.property.street, aerialRawSqft: e.rawAreaSqft, hoverSqft: m.roofAreaSqft,
          hoverEavesFt: m.eavesFt10 / 10, hoverRakesFt: m.rakesFt10 / 10, hoverRidgesHipsFt: m.ridgesHipsFt10 / 10, hoverValleysFt: m.valleysFt10 / 10,
        });
      }
      return out.sort((a, b) => b.jobNumber - a.jobNumber);
    },
  };
}
