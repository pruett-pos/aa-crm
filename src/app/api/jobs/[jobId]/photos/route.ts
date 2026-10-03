import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getCompanyCamClient, getCompanyCamStore } from "@/lib/companycam/index.ts";
import { canManageProject, canSeePhotos, canUnlinkProject, photosFor } from "@/lib/companycam/logic.ts";
import { getProductionStore } from "@/lib/production/index.ts";

type Ctx = { params: Promise<{ jobId: string }> };

// Roles: admin and the job's estimator; a PM with a trade on the job; a crew leader assigned to a trade.
// Thumbnails only, fetched live from CompanyCam and never stored. Customer details and prices are not part of the response.
export async function GET(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator", "production_manager", "crew_leader");
  if (!check.ok) return check.response;
  if (!allow(`photos:${check.user.id}`, 120, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { jobId } = await params;
  const actor = { id: check.user.id, role: check.user.role };
  const prod = getProductionStore();
  const job = await prod.getJob(jobId);
  if (!job) return Response.json({ error: "not_found" }, { status: 404 });
  const [trades, pm] = await Promise.all([prod.listTrades(jobId), prod.pmDivisions(actor.id)]);
  if (!canSeePhotos(actor, job, trades, pm)) return Response.json({ error: "forbidden" }, { status: 403 });
  const cc = await getCompanyCamStore().getJob(jobId);
  if (!cc) return Response.json({ error: "not_found" }, { status: 404 });
  const view = await photosFor(getCompanyCamClient(), cc);
  return Response.json({ ...view, canManage: canManageProject(actor, job), canUnlink: canUnlinkProject(actor), linkMethod: cc.linkMethod });
}
