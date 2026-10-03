import { requireRole } from "@/lib/auth/index.ts";
import { ROLES } from "@/lib/auth/roles.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getCommissionStore } from "@/lib/commission/index.ts";
import { toCsv } from "@/lib/reports/csv.ts";
import { getReportStore } from "@/lib/reports/index.ts";
import { ReportError, buildReport } from "@/lib/reports/logic.ts";

type Ctx = { params: Promise<{ name: string }> };
const STATUS: Record<string, number> = { forbidden: 403, unknown_report: 404 };

// Roles: whoever may see that report (admin and accounting all; PM, estimator and CSR a limited set).
// buildReport enforces the role, the grouping and which rows the user may see.
export async function GET(req: Request, { params }: Ctx) {
  const check = await requireRole(...ROLES);
  if (!check.ok) return check.response;
  if (!allow(`report:${check.user.id}`, 120, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });

  const { name } = await params;
  const q = new URL(req.url).searchParams;
  try {
    const table = await buildReport(getReportStore(), getCommissionStore(), check.user, {
      name, from: q.get("from"), to: q.get("to"), by: q.get("by"),
    });
    if (q.get("format") === "csv") {
      return new Response(toCsv(table), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${table.name}.csv"`,
          "cache-control": "private, no-store",
        },
      });
    }
    return Response.json(table);
  } catch (e) {
    if (e instanceof ReportError) return Response.json({ error: e.code }, { status: STATUS[e.code] ?? 400 });
    throw e;
  }
}
