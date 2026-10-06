import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getWorkOrderStore } from "@/lib/workorders/index.ts";
import { createWorkOrdersFor, workOrdersView } from "@/lib/workorders/logic.ts";
import { workOrderErrorResponse } from "@/lib/workorders/http.ts";

type Ctx = { params: Promise<{ jobId: string }> };

// Roles: admin and the job's estimator (full view and editing); a PM sees their trades' orders; a crew leader sees ISSUED orders
// for their own confirmed trade only. workOrdersView decides exactly what each gets. No prices exist on a work order.
export async function GET(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator", "production_manager", "crew_leader");
  if (!check.ok) return check.response;
  const { jobId } = await params;
  try {
    return Response.json(await workOrdersView(getWorkOrderStore(), { id: check.user.id, role: check.user.role }, jobId));
  } catch (e) {
    return workOrderErrorResponse(e);
  }
}

const Body = z.object({ action: z.literal("create") });

// Roles: admin and the job's estimator. Makes the draft work orders for any trade that doesn't have one (safe to repeat).
export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  if (!allow(`wo:${check.user.id}`, 60, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  if (!Body.safeParse(await req.json().catch(() => null)).success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { jobId } = await params;
  try {
    return Response.json(await createWorkOrdersFor(getWorkOrderStore(), { id: check.user.id, role: check.user.role }, jobId), { status: 201 });
  } catch (e) {
    return workOrderErrorResponse(e);
  }
}
