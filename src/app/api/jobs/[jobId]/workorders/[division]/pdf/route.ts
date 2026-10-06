import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getWorkOrderStore } from "@/lib/workorders/index.ts";
import { workOrderPdfData } from "@/lib/workorders/logic.ts";
import { workOrderErrorResponse } from "@/lib/workorders/http.ts";
import { renderWorkOrderPdf } from "@/lib/workorders/pdf.ts";

type Ctx = { params: Promise<{ jobId: string; division: string }> };

// Roles: admin and the job's estimator (drafts and issued), the trade's PM, and the assigned crew leader (issued only, once the
// trade is confirmed). Anyone else is told it doesn't exist. Never a public link. No prices, no customer name or phone.
export async function GET(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator", "production_manager", "crew_leader");
  if (!check.ok) return check.response;
  if (!allow(`wopdf:${check.user.id}`, 120, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { jobId, division } = await params;
  try {
    const data = await workOrderPdfData(getWorkOrderStore(), { id: check.user.id, role: check.user.role }, jobId, division);
    const pdf = await renderWorkOrderPdf(data);
    return new Response(Buffer.from(pdf), {
      headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="work-order-job-${data.jobNumber}-${division}.pdf"`, "cache-control": "private, no-store" },
    });
  } catch (e) {
    return workOrderErrorResponse(e);
  }
}
