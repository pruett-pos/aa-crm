import type { Division } from "../rules.ts";
import type { MeasurementJob, MeasurementRecord, MeasurementStore, NewMeasurement } from "./types.ts";

/** In-memory store for tests. Not used by the app. */
export class MemoryMeasurementStore implements MeasurementStore {
  jobs: MeasurementJob[] = [];
  pm = new Map<string, Division[]>();
  rows: (MeasurementRecord & { raw: unknown })[] = [];
  private n = 0;

  addJob(over: Partial<MeasurementJob> = {}): MeasurementJob {
    const k = this.jobs.length + 1;
    const job: MeasurementJob = {
      id: `j${k}`, jobNumber: k, stage: "inspected", estimatorId: "est1", divisions: ["roofing"],
      street: "100 Example Rd", city: "West Plains", zip: "65775", ...over,
    };
    this.jobs.push(job);
    return job;
  }

  async getJob(jobId: string) { const j = this.jobs.find((x) => x.id === jobId); return j ? { ...j } : null; }
  async pmDivisions(userId: string) { return [...(this.pm.get(userId) ?? [])]; }
  async list(jobId: string) {
    return this.rows.filter((r) => r.jobId === jobId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).map(({ raw: _r, ...rest }) => { void _r; return rest; });
  }
  async insert(jobId: string, m: NewMeasurement) {
    const { raw, ...fields } = m;
    const rec = { ...fields, id: `m${++this.n}`, jobId, createdAt: new Date(Date.UTC(2026, 9, 14, 12, 0, this.n)), raw };
    this.rows.push(rec);
    const { raw: _r, ...out } = rec; void _r;
    return out as MeasurementRecord;
  }
}
