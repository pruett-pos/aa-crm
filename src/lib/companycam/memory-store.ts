import type { CcJob, CcLinkMethod, CompanyCamStore } from "./types.ts";

/** In-memory store for tests. Not used by the app. */
export class MemoryCompanyCamStore implements CompanyCamStore {
  jobs: CcJob[] = [];

  add(over: Partial<CcJob> = {}): CcJob {
    const n = this.jobs.length + 1;
    const job: CcJob = {
      id: `j${n}`, jobNumber: n, stage: "new_lead", needsReview: false, firstName: "Dana", lastName: "Miller",
      street: "100 Example Rd", city: "West Plains", state: "MO", zip: "65775", divisions: ["roofing"], estimatorId: "est1",
      status: "none", projectId: null, projectUrl: null, linkMethod: null, attempts: 0, nextAttemptAt: null, error: null, ...over,
    };
    this.jobs.push(job);
    return job;
  }

  async getJob(jobId: string) { return this.jobs.find((j) => j.id === jobId) ?? null; }

  async claim(jobId: string, now: Date, leaseSeconds: number, opts: { force: boolean; maxAttempts: number }) {
    const j = this.jobs.find((x) => x.id === jobId);
    if (!j || j.status === "linked") return null;
    const leaseActive = j.status === "pending" && j.nextAttemptAt !== null && j.nextAttemptAt > now;
    if (leaseActive) return null;
    if (!opts.force) {
      if (j.attempts >= opts.maxAttempts) return null;
      if (j.status === "error" && j.nextAttemptAt !== null && j.nextAttemptAt > now) return null;
    }
    j.status = "pending";
    j.nextAttemptAt = new Date(now.getTime() + leaseSeconds * 1000);
    return { ...j };
  }

  async setLinked(jobId: string, l: { projectId: string; projectUrl: string | null; method: CcLinkMethod }) {
    if (this.jobs.some((j) => j.id !== jobId && j.projectId === l.projectId)) return false;
    const j = this.jobs.find((x) => x.id === jobId)!;
    Object.assign(j, { status: "linked", projectId: l.projectId, projectUrl: l.projectUrl, linkMethod: l.method, attempts: 0, nextAttemptAt: null, error: null });
    return true;
  }
  async setError(jobId: string, e: { error: string; attempts: number; nextAttemptAt: Date }) {
    const j = this.jobs.find((x) => x.id === jobId)!;
    Object.assign(j, { status: "error", error: e.error, attempts: e.attempts, nextAttemptAt: e.nextAttemptAt });
  }
  async setUnlinked(jobId: string) {
    const j = this.jobs.find((x) => x.id === jobId)!;
    Object.assign(j, { status: "none", projectId: null, projectUrl: null, linkMethod: null, attempts: 0, nextAttemptAt: null, error: null });
  }
  async projectOwner(projectId: string) { return this.jobs.find((j) => j.projectId === projectId)?.id ?? null; }
  async listNeedingSync(limit: number, now: Date, maxAttempts: number) {
    return this.jobs
      .filter((j) => j.status !== "linked" && !j.needsReview && j.stage !== "lost" && j.stage !== "cancelled_after_approval"
        && j.attempts < maxAttempts && (j.nextAttemptAt === null || j.nextAttemptAt <= now))
      .slice(0, limit).map((j) => ({ ...j }));
  }
}
