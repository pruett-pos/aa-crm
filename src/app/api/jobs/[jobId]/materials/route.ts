import { requireRole } from "@/lib/auth/index.ts";
import { en } from "@/i18n/en.ts";
import { materialTable } from "@/lib/production/materials.ts";
import { getProductionStore } from "@/lib/production/index.ts";
import { productionView } from "@/lib/production/logic.ts";
import { productionErrorResponse } from "@/lib/production/http.ts";
import { toCsv } from "@/lib/reports/csv.ts";

type Ctx = { params: Promise<{ jobId: string }> };

// Roles: whoever may see the job's production page. Staff get every trade; a PM or crew leader only their own trades.
// The list never contains a price, cost or margin.
export async function GET(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator", "production_manager", "crew_leader");
  if (!check.ok) return check.response;
  const { jobId } = await params;
  try {
    const view = await productionView(getProductionStore(), { id: check.user.id, role: check.user.role }, jobId);
    if (!view.materials) return Response.json({ error: "no_signed_contract" }, { status: 409 });
    if (new URL(req.url).searchParams.get("format") === "csv") {
      const table = materialTable(view.materials, (d) => (en.leads.divisionNames as Record<string, string>)[d] ?? d);
      return new Response(toCsv(table), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="materials-job-${view.job.jobNumber}.csv"`,
          "cache-control": "private, no-store",
        },
      });
    }
    return Response.json(view.materials);
  } catch (e) {
    return productionErrorResponse(e);
  }
}
