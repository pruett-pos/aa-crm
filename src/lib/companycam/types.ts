import type { Division } from "../rules.ts";

export type CcStatus = "none" | "pending" | "linked" | "error";
export type CcLinkMethod = "created" | "auto_match" | "manual";

export type CcJob = {
  id: string;
  jobNumber: number;
  stage: string;
  needsReview: boolean;
  firstName: string;
  lastName: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  divisions: Division[];
  estimatorId: string | null;
  status: CcStatus;
  projectId: string | null;
  projectUrl: string | null;
  linkMethod: CcLinkMethod | null;
  attempts: number;
  nextAttemptAt: Date | null;
  error: string | null;
};

export interface CompanyCamStore {
  getJob(jobId: string): Promise<CcJob | null>;
  /**
   * Take the right to sync this job, so two syncs can't both create a project. Succeeds when the job isn't linked and either
   * nothing is in flight or the previous attempt's lease has run out; the retry time must have passed unless `force`.
   * Returns the job, or null if someone else holds it (or it is linked, or out of attempts without `force`).
   */
  claim(jobId: string, now: Date, leaseSeconds: number, opts: { force: boolean; maxAttempts: number }): Promise<CcJob | null>;
  /** Record the link. Returns false if that CompanyCam project already belongs to another job. */
  setLinked(jobId: string, l: { projectId: string; projectUrl: string | null; method: CcLinkMethod }): Promise<boolean>;
  setError(jobId: string, e: { error: string; attempts: number; nextAttemptAt: Date }): Promise<void>;
  setUnlinked(jobId: string): Promise<void>;
  /** The job that owns this CompanyCam project, if any. */
  projectOwner(projectId: string): Promise<string | null>;
  listNeedingSync(limit: number, now: Date, maxAttempts: number): Promise<CcJob[]>;
}
