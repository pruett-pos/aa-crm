import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getCommissionStore } from "@/lib/commission/index.ts";
import { recordDraw } from "@/lib/commission/logic.ts";
import { commissionErrorResponse } from "@/lib/commission/http.ts";

const Body = z.object({
  estimatorId: z.string().max(64), amount: z.string().max(20),
  paidOn: z.string().max(10).optional(), note: z.string().max(300).optional(),
});

// Roles: admin and accounting. A draw is an advance against future commission.
export async function POST(req: Request) {
  const check = await requireRole("admin", "accounting");
  if (!check.ok) return check.response;
  if (!allow(`draw:${check.user.id}`, 30, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  try {
    const d = await recordDraw(getCommissionStore(), {
      actorId: check.user.id, estimatorId: parsed.data.estimatorId, amountText: parsed.data.amount,
      paidOn: parsed.data.paidOn, note: parsed.data.note,
    });
    return Response.json(d, { status: 201 });
  } catch (e) {
    return commissionErrorResponse(e);
  }
}
