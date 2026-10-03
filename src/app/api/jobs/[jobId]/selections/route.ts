import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getProductionStore } from "@/lib/production/index.ts";
import { saveSelections } from "@/lib/production/logic.ts";
import { productionErrorResponse } from "@/lib/production/http.ts";

type Ctx = { params: Promise<{ jobId: string }> };
const Body = z.object({ items: z.array(z.object({ itemId: z.string().max(64), color: z.string().max(100).nullable() })).max(500) });

// Roles: the job's estimator or admin. Enter or change colors on the chosen packages after signing and before the order.
// Colors never change a price.
export async function PUT(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  if (!allow(`selections:${check.user.id}`, 60, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { jobId } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  try {
    await saveSelections(getProductionStore(), { actor: { id: check.user.id, role: check.user.role }, jobId, items: parsed.data.items });
    return Response.json({ saved: parsed.data.items.length });
  } catch (e) {
    return productionErrorResponse(e);
  }
}
