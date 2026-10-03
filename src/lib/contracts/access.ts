import type { AuthUser } from "../auth/store.ts";
import { canReadScopes, canWriteScopes } from "../scopes/service.ts";
import type { JobAccess, ScopeStore } from "../scopes/types.ts";
import { ContractError } from "./sign.ts";

/** Same rule as scopes: admin and the job's own estimator write; PMs read from contract onward. */
export async function authorizeJob(
  scopes: ScopeStore, user: AuthUser, jobId: string, mode: "read" | "write",
): Promise<{ job: JobAccess } | { response: Response }> {
  const job = await scopes.getJob(jobId);
  if (!job) return { response: Response.json({ error: "not_found" }, { status: 404 }) };
  const allowed = mode === "write"
    ? canWriteScopes(user, job)
    : canReadScopes(user, job, await scopes.divisionManagerIds(job.divisions));
  if (!allowed) return { response: Response.json({ error: "forbidden" }, { status: 403 }) };
  return { job };
}

const STATUS: Record<string, number> = {
  not_found: 404, already_signed: 409, tampered: 409, not_draft: 409, job_closed: 409,
};

export function contractErrorResponse(e: unknown): Response {
  if (e instanceof ContractError) {
    return Response.json({ error: e.code, message: e.message }, { status: STATUS[e.code] ?? 400 });
  }
  throw e;
}

export function clientIp(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}
