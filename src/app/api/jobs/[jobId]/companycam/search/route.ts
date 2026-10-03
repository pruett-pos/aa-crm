import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getCompanyCamClient, getCompanyCamStore } from "@/lib/companycam/index.ts";
import { companyCamErrorResponse } from "@/lib/companycam/http.ts";
import { canManageProject, searchForLink } from "@/lib/companycam/logic.ts";
import { getProductionStore } from "@/lib/production/index.ts";

type Ctx = { params: Promise<{ jobId: string }> };

// Roles: admin and the job's own estimator (the people who can link a project).
export async function GET(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  if (!allow(`ccsearch:${check.user.id}`, 60, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { jobId } = await params;
  const job = await getProductionStore().getJob(jobId);
  if (!job) return Response.json({ error: "not_found" }, { status: 404 });
  if (!canManageProject({ id: check.user.id, role: check.user.role }, job)) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const q = new URL(req.url).searchParams.get("q") ?? "";
    return Response.json({ projects: await searchForLink(getCompanyCamStore(), getCompanyCamClient(), q) });
  } catch (e) {
    return companyCamErrorResponse(e);
  }
}
