import { requireRole } from "@/lib/auth/index.ts";
import { getProductionStore } from "@/lib/production/index.ts";
import { productionView } from "@/lib/production/logic.ts";
import { productionErrorResponse } from "@/lib/production/http.ts";

type Ctx = { params: Promise<{ jobId: string }> };

// Roles: admin and the job's estimator see the whole job; a PM sees the trades they manage; a crew leader sees trades assigned to them.
// productionView enforces who sees what (a crew leader never gets prices or the customer's name).
export async function GET(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator", "production_manager", "crew_leader");
  if (!check.ok) return check.response;
  const { jobId } = await params;
  try {
    return Response.json(await productionView(getProductionStore(), { id: check.user.id, role: check.user.role }, jobId));
  } catch (e) {
    return productionErrorResponse(e);
  }
}
