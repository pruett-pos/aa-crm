import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getCompanyCamClient, getCompanyCamStore } from "@/lib/companycam/index.ts";
import { companyCamErrorResponse } from "@/lib/companycam/http.ts";
import { canManageProject, canUnlinkProject, ensureProject, linkProject, unlinkProject } from "@/lib/companycam/logic.ts";
import { getProductionStore } from "@/lib/production/index.ts";

type Ctx = { params: Promise<{ jobId: string }> };
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create") }),
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("link"), projectId: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/) }),
  z.object({ action: z.literal("unlink") }),
]);

// Roles: admin and the job's own estimator create, link and retry. Only admin unlinks. Nothing is ever deleted in CompanyCam.
export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  if (!allow(`cc:${check.user.id}`, 30, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { jobId } = await params;
  const actor = { id: check.user.id, role: check.user.role };
  const job = await getProductionStore().getJob(jobId);
  if (!job) return Response.json({ error: "not_found" }, { status: 404 });
  const a = parsed.data;
  if (!canManageProject(actor, job) || (a.action === "unlink" && !canUnlinkProject(actor))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const store = getCompanyCamStore(), client = getCompanyCamClient();
  try {
    if (a.action === "link") await linkProject(store, client, { jobId, projectId: a.projectId });
    else if (a.action === "unlink") await unlinkProject(store, jobId);
    else {
      // A person pressing the button doesn't wait out the automatic backoff.
      const r = await ensureProject(store, client, jobId, { force: true });
      if (r.status === "not_configured") return Response.json({ error: "not_configured" }, { status: 503 });
      if (r.status === "error") return Response.json({ error: "service_error", kind: r.kind }, { status: 502 });
      if (r.status === "skipped") return Response.json({ error: r.reason }, { status: 409 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return companyCamErrorResponse(e);
  }
}
