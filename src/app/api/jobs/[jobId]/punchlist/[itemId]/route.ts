import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getCloseoutStore } from "@/lib/closeout/index.ts";
import { editItem, removeItem, setItemDone } from "@/lib/closeout/logic.ts";
import { closeoutErrorResponse } from "@/lib/closeout/http.ts";

type Ctx = { params: Promise<{ jobId: string; itemId: string }> };
const Body = z.object({
  done: z.boolean().optional(),
  labelEn: z.string().max(400).optional(),
  labelRu: z.string().max(400).nullable().optional(),
}).refine((b) => b.done !== undefined || b.labelEn !== undefined || b.labelRu !== undefined);

// Roles: ticking is open to admin, the job's estimator, the PM of the trade and the assigned crew leader; renaming and removing
// are not open to crew leaders. The logic checks each item against the person's trades.
export async function PATCH(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator", "production_manager", "crew_leader");
  if (!check.ok) return check.response;
  if (!allow(`punch:${check.user.id}`, 300, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { jobId, itemId } = await params;
  const actor = { id: check.user.id, role: check.user.role };
  const b = parsed.data;
  try {
    if (b.labelEn !== undefined || b.labelRu !== undefined) await editItem(getCloseoutStore(), actor, jobId, itemId, { labelEn: b.labelEn, labelRu: b.labelRu });
    if (b.done !== undefined) await setItemDone(getCloseoutStore(), actor, jobId, itemId, b.done);
    return Response.json({ ok: true });
  } catch (e) {
    return closeoutErrorResponse(e);
  }
}

// Roles: admin, the job's estimator, and the PM of the trade.
export async function DELETE(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator", "production_manager");
  if (!check.ok) return check.response;
  if (!allow(`punch:${check.user.id}`, 120, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { jobId, itemId } = await params;
  try {
    await removeItem(getCloseoutStore(), { id: check.user.id, role: check.user.role }, jobId, itemId);
    return Response.json({ ok: true });
  } catch (e) {
    return closeoutErrorResponse(e);
  }
}
