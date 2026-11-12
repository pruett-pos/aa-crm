import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { recordAudit } from "@/lib/audit/index.ts";
import { getAerialStore, getGoogleSolarClient } from "@/lib/aerial/index.ts";
import { fetchEstimateForJob } from "@/lib/aerial/logic.ts";

type Ctx = { params: Promise<{ jobId: string }> };

// Roles: admin only. "Fetch again" for a property marked "No aerial data" (or to refresh one). Each press calls Google.
export async function POST(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  if (!allow(`aerial:${check.user.id}`, 20, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { jobId } = await params;
  const result = await fetchEstimateForJob({ store: getAerialStore(), client: getGoogleSolarClient() }, jobId, { force: true });
  if (result.status === "skipped" && result.reason === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
  await recordAudit(check.user, { action: "aerial.fetched_again", entityType: "job", entityId: jobId, summary: `Aerial estimate fetched again: ${result.status}`, details: { result } });
  return Response.json({ result });
}
