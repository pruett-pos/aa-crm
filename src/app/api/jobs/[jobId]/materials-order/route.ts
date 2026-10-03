import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getProductionStore } from "@/lib/production/index.ts";
import { recordMaterialsOrder } from "@/lib/production/logic.ts";
import { productionErrorResponse } from "@/lib/production/http.ts";

type Ctx = { params: Promise<{ jobId: string }> };
const Body = z.object({ poReference: z.string().max(100), notes: z.string().max(400).nullable().optional() });

// Roles: the job's estimator or admin. Records that the materials were ordered (with the PO number) and moves the job on.
// Until the Pruett link exists the order itself is placed by hand.
export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  if (!allow(`order:${check.user.id}`, 30, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { jobId } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  try {
    await recordMaterialsOrder(getProductionStore(), {
      actor: { id: check.user.id, role: check.user.role }, jobId, poReference: parsed.data.poReference, notes: parsed.data.notes ?? null,
    });
    return Response.json({ ordered: true }, { status: 201 });
  } catch (e) {
    return productionErrorResponse(e);
  }
}
