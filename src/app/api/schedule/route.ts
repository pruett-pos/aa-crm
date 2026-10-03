import { requireRole } from "@/lib/auth/index.ts";
import { getProductionStore } from "@/lib/production/index.ts";
import { ProductionError, scheduleBoard } from "@/lib/production/logic.ts";
import { productionErrorResponse } from "@/lib/production/http.ts";
import { ReportError, parseRange } from "@/lib/reports/logic.ts";

const MAX_DAYS = 62;

// Roles: admin sees every trade; an estimator their own jobs; a PM their divisions; a crew leader only trades assigned to them.
export async function GET(req: Request) {
  const check = await requireRole("admin", "estimator", "production_manager", "crew_leader");
  if (!check.ok) return check.response;
  const q = new URL(req.url).searchParams;
  try {
    const range = parseRange(q.get("from"), q.get("to"));
    if ((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 > MAX_DAYS) throw new ProductionError("invalid_range");
    return Response.json(await scheduleBoard(
      getProductionStore(), { id: check.user.id, role: check.user.role }, range,
      { division: q.get("division"), crewLeaderId: q.get("crew") },
    ));
  } catch (e) {
    if (e instanceof ReportError) return Response.json({ error: "invalid_range" }, { status: 400 });
    return productionErrorResponse(e);
  }
}
