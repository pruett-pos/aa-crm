import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { sendInvoiceEmail } from "@/integrations/resend/index.ts";
import { getCloseoutStore } from "@/lib/closeout/index.ts";
import { issueInvoice, sendInvoice, voidInvoice } from "@/lib/closeout/logic.ts";
import { closeoutErrorResponse } from "@/lib/closeout/http.ts";

type Ctx = { params: Promise<{ jobId: string }> };
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("issue") }),
  z.object({ action: z.literal("send"), to: z.string().max(254).nullable().optional() }),
  z.object({ action: z.literal("void"), reason: z.string().max(600) }),
]);

// Roles: admin and accounting only (the logic checks again). The job's estimator and PM view the invoice through the closeout screen.
export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "accounting");
  if (!check.ok) return check.response;
  if (!allow(`invoice:${check.user.id}`, 60, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { jobId } = await params;
  const actor = { id: check.user.id, role: check.user.role };
  const store = getCloseoutStore();
  try {
    const b = parsed.data;
    if (b.action === "issue") {
      const r = await issueInvoice(store, actor, jobId);
      return Response.json({ invoiceNumber: r.invoice.invoiceNumber, stage: r.stage }, { status: 201 });
    }
    if (b.action === "send") return Response.json(await sendInvoice(store, actor, jobId, { to: b.to }, sendInvoiceEmail));
    await voidInvoice(store, actor, jobId, b.reason);
    return Response.json({ ok: true });
  } catch (e) {
    return closeoutErrorResponse(e);
  }
}
