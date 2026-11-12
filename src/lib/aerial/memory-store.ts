import { DEFAULT_SETTINGS } from "./logic.ts";
import type { AerialEstimate, AerialJob, AerialNumbers, AerialSettings, AerialStore, CalibrationSource } from "./types.ts";

type Row = AerialEstimate & { raw: unknown; image: { data: Uint8Array; mime: string } | null };

/** In-memory store for tests. Not used by the app. */
export class MemoryAerialStore implements AerialStore {
  settings: AerialSettings = { ...DEFAULT_SETTINGS, enabled: true };
  jobs: AerialJob[] = [];
  rows = new Map<string, Row>();
  sources: CalibrationSource[] = [];
  /** Set to make every write fail, to prove a broken database never escapes the background fetch. */
  failWrites = false;

  addJob(over: Partial<AerialJob> = {}): AerialJob {
    const k = this.jobs.length + 1;
    const job: AerialJob = {
      id: `j${k}`, jobNumber: k, jobType: "retail", stage: "appointment_set", divisions: ["roofing"], appointmentAt: new Date("2026-11-20T15:00:00Z"),
      estimatorName: "Sam Estimator", propertyId: `p${k}`, street: "100 Example Rd", city: "West Plains", state: "MO", zip: "65775", ...over,
    };
    this.jobs.push(job);
    return job;
  }

  async getSettings() { return { ...this.settings }; }
  async saveSettings(s: AerialSettings) { this.settings = { ...s }; }
  async getJob(jobId: string) { const j = this.jobs.find((x) => x.id === jobId); return j ? { ...j } : null; }
  async getEstimate(propertyId: string) {
    const r = this.rows.get(propertyId);
    if (!r) return null;
    const { raw: _r, image: _i, ...rest } = r; void _r; void _i;
    return { ...rest };
  }
  async claim(propertyId: string, now: Date, opts: { staleBefore: Date; force: boolean }) {
    if (this.failWrites) throw new Error("database down");
    const r = this.rows.get(propertyId);
    const stale = r?.status === "pending" && r.updatedAt < opts.staleBefore;
    if (r && !stale && !(opts.force && r.status !== "pending")) return false;
    this.rows.set(propertyId, { propertyId, status: "pending", attempts: 0, error: null, hasImage: false, fetchedAt: null, updatedAt: now, raw: null, image: null });
    return true;
  }
  async saveOk(propertyId: string, a: { numbers: AerialNumbers; raw: unknown; image: { data: Uint8Array; mime: string } | null; attempts: number; fetchedAt: Date }) {
    if (this.failWrites) throw new Error("database down");
    this.rows.set(propertyId, {
      propertyId, status: "ok", attempts: a.attempts, error: null, hasImage: a.image !== null, fetchedAt: a.fetchedAt, updatedAt: a.fetchedAt,
      ...a.numbers, raw: a.raw, image: a.image,
    });
  }
  async saveFailure(propertyId: string, a: { status: "no_data" | "error"; error: string; attempts: number }) {
    if (this.failWrites) throw new Error("database down");
    this.rows.set(propertyId, { propertyId, status: a.status, attempts: a.attempts, error: a.error, hasImage: false, fetchedAt: null, updatedAt: new Date(), raw: null, image: null });
  }
  async getImage(propertyId: string) { return this.rows.get(propertyId)?.image ?? null; }
  async calibrationSources() { return this.sources.map((s) => ({ ...s })); }
}
