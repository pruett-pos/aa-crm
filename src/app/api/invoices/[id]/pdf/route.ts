import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getCloseoutStore } from "@/lib/closeout/index.ts";
import { invoicePdfFor } from "@/lib/closeout/logic.ts";
import { closeoutErrorResponse } from "@/lib/closeout/http.ts";

type Ctx = { params: Promise<{ id: string }> };

// Roles: admin, accounting, the job's estimator, and a PM with a trade on the job. Everyone else is told it doesn't exist.
// Never a public link: the PDF is only served to a signed-in person with rights to the job.
export async function GET(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "accounting", "estimator", "production_manager");
  if (!check.ok) return check.response;
  if (!allow(`invoicepdf:${check.user.id}`, 120, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { id } = await params;
  try {
    const { pdf, filename } = await invoicePdfFor(getCloseoutStore(), { id: check.user.id, role: check.user.role }, id);
    return new Response(Buffer.from(pdf), {
      headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${filename}"`, "cache-control": "private, no-store" },
    });
  } catch (e) {
    return closeoutErrorResponse(e);
  }
}
