import { requireRole } from "@/lib/auth/index.ts";
import { getCloseoutStore } from "@/lib/closeout/index.ts";
import { closeoutView } from "@/lib/closeout/logic.ts";
import { closeoutErrorResponse } from "@/lib/closeout/http.ts";

type Ctx = { params: Promise<{ jobId: string }> };

// Roles: admin, the job's estimator, a PM with a trade on the job, an assigned crew leader (their items only, no prices or customer),
// and accounting (read-only). closeoutView decides exactly what each of them gets.
export async function GET(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator", "production_manager", "crew_leader", "accounting");
  if (!check.ok) return check.response;
  const { jobId } = await params;
  try {
    return Response.json(await closeoutView(getCloseoutStore(), { id: check.user.id, role: check.user.role }, jobId));
  } catch (e) {
    return closeoutErrorResponse(e);
  }
}
