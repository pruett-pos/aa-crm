import { requireRole } from "@/lib/auth/index.ts";
import { getCommissionStore } from "@/lib/commission/index.ts";
import { payoutOverview } from "@/lib/commission/logic.ts";

// Roles: admin and accounting. The latest closed pay period per estimator, with draws and net.
export async function GET() {
  const check = await requireRole("admin", "accounting");
  if (!check.ok) return check.response;
  return Response.json(await payoutOverview(getCommissionStore()));
}
