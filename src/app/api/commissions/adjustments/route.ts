import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getCommissionStore } from "@/lib/commission/index.ts";
import { addAdjustment } from "@/lib/commission/logic.ts";
import { commissionErrorResponse } from "@/lib/commission/http.ts";

const Body = z.object({ estimatorId: z.string().max(64), amount: z.string().max(21), reason: z.string().max(300) });

// Roles: admin only. A manual correction to the ledger (positive or negative), with a required reason.
export async function POST(req: Request) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  if (!allow(`adjust:${check.user.id}`, 30, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  try {
    const e = await addAdjustment(getCommissionStore(), {
      actorId: check.user.id, estimatorId: parsed.data.estimatorId, amountText: parsed.data.amount, reason: parsed.data.reason,
    });
    return Response.json(e, { status: 201 });
  } catch (e) {
    return commissionErrorResponse(e);
  }
}
