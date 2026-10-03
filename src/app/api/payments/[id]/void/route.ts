import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { getPaymentStore } from "@/lib/payments/index.ts";
import { voidPayment } from "@/lib/payments/logic.ts";
import { paymentErrorResponse } from "@/lib/payments/http.ts";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ reason: z.string().max(300) });

// Roles: admin and accounting only. Payments are voided with a reason, never deleted.
export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "accounting");
  if (!check.ok) return check.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { id } = await params;
  try {
    const r = await voidPayment(getPaymentStore(), { paymentId: id, userId: check.user.id, reason: parsed.data.reason });
    return Response.json({ voided: true, depositNoLongerCovered: r.depositNoLongerCovered });
  } catch (e) {
    return paymentErrorResponse(e);
  }
}
