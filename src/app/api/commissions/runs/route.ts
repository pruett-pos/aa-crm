import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getCommissionStore } from "@/lib/commission/index.ts";
import { runPayout } from "@/lib/commission/logic.ts";
import { commissionErrorResponse } from "@/lib/commission/http.ts";

const Body = z.object({ estimatorId: z.string().max(64), periodEnd: z.string().max(10), note: z.string().max(300).optional() });

// Roles: admin and accounting. Records a payout for a closed pay period; money is paid outside the CRM.
export async function POST(req: Request) {
  const check = await requireRole("admin", "accounting");
  if (!check.ok) return check.response;
  if (!allow(`payout:${check.user.id}`, 30, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  try {
    const r = await runPayout(getCommissionStore(), { actorId: check.user.id, ...parsed.data });
    return Response.json(r, { status: 201 });
  } catch (e) {
    return commissionErrorResponse(e);
  }
}
