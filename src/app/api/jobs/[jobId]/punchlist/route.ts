import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getCloseoutStore } from "@/lib/closeout/index.ts";
import { addItem, startPunchlist } from "@/lib/closeout/logic.ts";
import { closeoutErrorResponse } from "@/lib/closeout/http.ts";
import type { Division } from "@/lib/rules.ts";

type Ctx = { params: Promise<{ jobId: string }> };
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({
    action: z.literal("add"),
    division: z.string().max(30).nullable(),            // checked against the job's own trades in addItem
    labelEn: z.string().max(400),
    labelRu: z.string().max(400).nullable().optional(),
  }),
]);

// Roles: admin, the job's estimator and a PM start the list and add items (the PM only for their own trades and whole-job items).
export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator", "production_manager");
  if (!check.ok) return check.response;
  if (!allow(`punch:${check.user.id}`, 120, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { jobId } = await params;
  const actor = { id: check.user.id, role: check.user.role };
  try {
    const b = parsed.data;
    if (b.action === "start") return Response.json(await startPunchlist(getCloseoutStore(), actor, jobId), { status: 201 });
    await addItem(getCloseoutStore(), actor, jobId, { division: b.division as Division | null, labelEn: b.labelEn, labelRu: b.labelRu });
    return Response.json({ ok: true }, { status: 201 });
  } catch (e) {
    return closeoutErrorResponse(e);
  }
}
