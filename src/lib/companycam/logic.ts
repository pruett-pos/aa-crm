import { en } from "../../i18n/en.ts";
import {
  CompanyCamError, type CcPhoto, type CcProject, type CompanyCamClient, type CompanyCamErrorKind,
} from "../../integrations/companycam/client.ts";
import { jobRights, tradeRights } from "../production/rights.ts";
import type { Actor, ProductionJob, TradeRow } from "../production/types.ts";
import type { Division } from "../rules.ts";
import { sameAddress, streetSearchWord } from "./address.ts";
import type { CcJob, CompanyCamStore } from "./types.ts";

export const MAX_ATTEMPTS = 8;
const LEASE_SECONDS = 180;
const DAY_MINUTES = 24 * 60;
const BACKOFF_MINUTES = [1, 5, 15, 60, 360, DAY_MINUTES];

/** How long to wait before the next try after this many failures. */
export function backoffMinutes(attempts: number, kind: CompanyCamErrorKind, retryAfterSeconds: number | null): number {
  if (kind === "auth") return DAY_MINUTES;                       // retrying won't help until someone fixes the token
  const base = BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1];
  return kind === "rate_limited" && retryAfterSeconds ? Math.max(base, Math.ceil(retryAfterSeconds / 60)) : base;
}

const tradeLabel = (d: string) => (en.leads.divisionNames as Record<string, string>)[d] ?? d;

/** "Last, First - Job 24 - Roofing + Siding", cleaned of control characters and capped in length. */
export function projectName(job: Pick<CcJob, "firstName" | "lastName" | "jobNumber" | "divisions">): string {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const who = [clean(job.lastName), clean(job.firstName)].filter(Boolean).join(", ");
  const trades = job.divisions.map(tradeLabel).join(" + ");
  return [who, `Job ${job.jobNumber}`, trades].filter(Boolean).join(" - ").slice(0, 120);
}

export type EnsureResult =
  | { status: "linked"; method: "created" | "auto_match"; projectId: string }
  | { status: "already_linked" }
  | { status: "skipped"; reason: "not_found" | "waiting_for_review" | "closed" | "busy" | "gave_up" }
  | { status: "not_configured" }
  | { status: "error"; kind: CompanyCamErrorKind; nextAttemptAt: Date };

/**
 * Make sure the job has a CompanyCam project: link an existing one at the same address if there is exactly one
 * that no other job owns, otherwise create one. Idempotent and safe to call twice at once. NEVER THROWS: a failed
 * or slow CompanyCam must never break the lead that triggered it; the failure is recorded for a retry instead.
 */
export async function ensureProject(
  store: CompanyCamStore, client: CompanyCamClient | null, jobId: string,
  opts: { now?: () => Date; force?: boolean } = {},
): Promise<EnsureResult> {
  const now = (opts.now ?? (() => new Date()))();
  if (!client) return { status: "not_configured" };
  try {
    const peek = await store.getJob(jobId);
    if (!peek) return { status: "skipped", reason: "not_found" };
    if (peek.status === "linked") return { status: "already_linked" };
    if (peek.needsReview) return { status: "skipped", reason: "waiting_for_review" };   // public form leads wait for a CSR
    if (peek.stage === "lost" || peek.stage === "cancelled_after_approval") return { status: "skipped", reason: "closed" };
    const job = await store.claim(jobId, now, LEASE_SECONDS, { force: opts.force ?? false, maxAttempts: MAX_ATTEMPTS });
    if (!job) return { status: "skipped", reason: peek.attempts >= MAX_ATTEMPTS && !opts.force ? "gave_up" : "busy" };

    try {
      const found = (await client.searchProjects(streetSearchWord(job.street))).filter((p) => p.status === "active" && sameAddress(p.address, job));
      const free: CcProject[] = [];
      for (const p of found) if ((await store.projectOwner(p.id)) === null) free.push(p);
      if (free.length === 1) {
        if (await store.setLinked(jobId, { projectId: free[0].id, projectUrl: free[0].projectUrl, method: "auto_match" })) {
          return { status: "linked", method: "auto_match", projectId: free[0].id };
        }
      }
      const created = await client.createProject({
        name: projectName(job), address: { street: job.street, city: job.city, state: job.state, postalCode: job.zip.slice(0, 5) },
        contactName: `${job.firstName} ${job.lastName}`.trim() || null,
      });
      if (!(await store.setLinked(jobId, { projectId: created.id, projectUrl: created.projectUrl, method: "created" }))) {
        throw new CompanyCamError("server", "CompanyCam project is already linked to another job");
      }
      return { status: "linked", method: "created", projectId: created.id };
    } catch (e) {
      const kind: CompanyCamErrorKind = e instanceof CompanyCamError ? e.kind : "server";
      const attempts = job.attempts + 1;
      const next = new Date(now.getTime() + backoffMinutes(attempts, kind, e instanceof CompanyCamError ? e.retryAfterSeconds : null) * 60_000);
      // Only a short, fixed description is stored; nothing from the response and never the token.
      await store.setError(jobId, { error: describe(kind), attempts, nextAttemptAt: next }).catch(() => undefined);
      return { status: "error", kind, nextAttemptAt: next };
    }
  } catch {
    return { status: "error", kind: "server", nextAttemptAt: new Date(now.getTime() + 5 * 60_000) };
  }
}

function describe(kind: CompanyCamErrorKind): string {
  return {
    auth: "CompanyCam rejected the access token", rate_limited: "CompanyCam is rate limiting requests", not_found: "CompanyCam could not find that project",
    bad_request: "CompanyCam rejected the project details", server: "CompanyCam had a problem", network: "Could not reach CompanyCam",
  }[kind];
}

// ---------- Manual link, unlink ----------
export type ManageErrorCode = "not_configured" | "not_found" | "forbidden" | "project_not_found" | "project_deleted" | "already_linked_elsewhere" | "already_linked" | "not_linked" | "service_error";
export class ManageError extends Error {
  code: ManageErrorCode;
  constructor(code: ManageErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/** Link a CompanyCam project a person picked. It must exist, be active, and not belong to another job. */
export async function linkProject(store: CompanyCamStore, client: CompanyCamClient | null, a: { jobId: string; projectId: string }): Promise<void> {
  if (!client) throw new ManageError("not_configured");
  const job = await store.getJob(a.jobId);
  if (!job) throw new ManageError("not_found");
  if (job.status === "linked") throw new ManageError("already_linked", "This job is already linked; unlink it first");
  let project: CcProject;
  try {
    project = await client.getProject(a.projectId);
  } catch (e) {
    throw e instanceof CompanyCamError && e.kind === "not_found" ? new ManageError("project_not_found") : new ManageError("service_error");
  }
  if (project.status !== "active") throw new ManageError("project_deleted");
  const owner = await store.projectOwner(project.id);
  if (owner !== null && owner !== a.jobId) throw new ManageError("already_linked_elsewhere", "That CompanyCam project belongs to another job");
  if (!(await store.setLinked(a.jobId, { projectId: project.id, projectUrl: project.projectUrl, method: "manual" }))) {
    throw new ManageError("already_linked_elsewhere", "That CompanyCam project belongs to another job");
  }
}

/** Remove the link. Nothing is deleted in CompanyCam. */
export async function unlinkProject(store: CompanyCamStore, jobId: string): Promise<void> {
  const job = await store.getJob(jobId);
  if (!job) throw new ManageError("not_found");
  if (job.status !== "linked") throw new ManageError("not_linked");
  await store.setUnlinked(jobId);
}

/** Search CompanyCam for a project to link, flagging ones other jobs already own. */
export async function searchForLink(
  store: CompanyCamStore, client: CompanyCamClient | null, query: string,
): Promise<{ id: string; name: string | null; address: string; url: string | null; linkedToJob: boolean }[]> {
  if (!client) throw new ManageError("not_configured");
  const q = query.trim();
  if (q.length < 3) return [];
  let found: CcProject[];
  try {
    found = await client.searchProjects(q.slice(0, 80));
  } catch {
    throw new ManageError("service_error");
  }
  const out = [];
  for (const p of found.filter((x) => x.status === "active").slice(0, 20)) {
    out.push({
      id: p.id, name: p.name, url: p.projectUrl, linkedToJob: (await store.projectOwner(p.id)) !== null,
      address: [p.address.street, p.address.city, p.address.state, p.address.postalCode].filter(Boolean).join(", "),
    });
  }
  return out;
}

// ---------- Who may do what ----------
/** Admin, the job's estimator, a PM with a trade on the job, and a crew leader assigned to a trade can see its photos. */
export function canSeePhotos(actor: Actor, job: ProductionJob, trades: TradeRow[], pm: readonly Division[]): boolean {
  return jobRights(actor, job, pm).canViewAll || trades.some((t) => tradeRights(actor, job, t, pm).canView);
}
/** Admin and the job's own estimator create, link and retry. */
export const canManageProject = (actor: Actor, job: Pick<ProductionJob, "estimatorId">) =>
  actor.role === "admin" || (actor.role === "estimator" && job.estimatorId === actor.id);
export const canUnlinkProject = (actor: Actor) => actor.role === "admin";

// ---------- Photos ----------
export type PhotosView =
  | { state: "not_configured" }
  | { state: "not_linked"; status: string; error: string | null }
  | { state: "error"; kind: CompanyCamErrorKind; projectUrl: string | null }
  | { state: "ok"; projectUrl: string | null; count: number; hasMore: boolean; photos: { id: string; thumbnailUrl: string; capturedAt: string | null; creatorName: string | null }[] };

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; photos: CcPhoto[]; hasMore: boolean }>();
export function clearPhotoCache() { cache.clear(); }

/** The newest few thumbnails, fetched live (cached about a minute) and never stored. */
export async function photosFor(
  client: CompanyCamClient | null, job: Pick<CcJob, "status" | "projectId" | "projectUrl" | "error">, now: () => number = Date.now,
): Promise<PhotosView> {
  if (!client) return { state: "not_configured" };
  if (job.status !== "linked" || !job.projectId) return { state: "not_linked", status: job.status, error: job.error };
  const hit = cache.get(job.projectId);
  let photos: CcPhoto[];
  let hasMore: boolean;
  if (hit && now() - hit.at < CACHE_MS) ({ photos, hasMore } = hit);
  else {
    try {
      ({ photos, hasMore } = await client.listPhotos(job.projectId, 100));
      cache.set(job.projectId, { at: now(), photos, hasMore });
    } catch (e) {
      return { state: "error", kind: e instanceof CompanyCamError ? e.kind : "server", projectUrl: job.projectUrl };
    }
  }
  const newest = [...photos]
    .sort((a, b) => (b.capturedAt ?? "").localeCompare(a.capturedAt ?? ""))
    .flatMap((p) => (p.thumbnailUrl ? [{ id: p.id, thumbnailUrl: p.thumbnailUrl, capturedAt: p.capturedAt, creatorName: p.creatorName }] : []))
    .slice(0, 8);
  return { state: "ok", projectUrl: job.projectUrl, count: photos.length, hasMore, photos: newest };
}
