import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getProductionStore } from "@/lib/production/index.ts";
import { completeTrade, confirmInstall, proposeInstall, startTrade } from "@/lib/production/logic.ts";
import { productionErrorResponse } from "@/lib/production/http.ts";

type Ctx = { params: Promise<{ jobId: string; division: string }> };

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("propose"), installDate: z.string().max(10) }),
  z.object({ action: z.literal("confirm"), installDate: z.string().max(10).nullable().optional(), crewLeaderId: z.string().max(64).nullable() }),
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("complete") }),
]);

// Roles: propose = the job's estimator or admin; confirm = the trade's Production Manager or admin;
// start and complete = the assigned crew leader, the trade's PM, or admin. The service enforces each of these and the gates.
export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator", "production_manager", "crew_leader");
  if (!check.ok) return check.response;
  if (!allow(`production:${check.user.id}`, 120, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { jobId, division } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });

  const store = getProductionStore();
  const actor = { id: check.user.id, role: check.user.role };
  const b = parsed.data;
  try {
    if (b.action === "propose") return Response.json({ trade: await proposeInstall(store, { actor, jobId, division, installDate: b.installDate }) });
    if (b.action === "confirm") {
      const r = await confirmInstall(store, { actor, jobId, division, installDate: b.installDate ?? null, crewLeaderId: b.crewLeaderId });
      return Response.json({ trade: r.trade, conflicts: r.conflicts });
    }
    if (b.action === "start") return Response.json({ trade: await startTrade(store, { actor, jobId, division }) });
    return Response.json({ trade: await completeTrade(store, { actor, jobId, division }) });
  } catch (e) {
    return productionErrorResponse(e);
  }
}
