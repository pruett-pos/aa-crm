import { requireRole } from "@/lib/auth/index.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { loadScopeData } from "@/lib/scopes/load.ts";

type Ctx = { params: Promise<{ jobId: string }> };

// Roles: admin, estimator (own jobs), production_manager (their division, from contract onward).
export async function GET(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator", "production_manager");
  if (!check.ok) return check.response;
  const { jobId } = await params;

  const data = await loadScopeData(getScopeStore(), check.user, jobId);
  if (data.status === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
  if (data.status === "forbidden") return Response.json({ error: "forbidden" }, { status: 403 });
  const { canEdit, products, scopes } = data;
  return Response.json({
    canEdit,
    products: products.map(({ retailCents: _retail, ...p }) => p), // retail price stays server/page side
    scopes,
  });
}
