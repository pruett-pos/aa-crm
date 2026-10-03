import { requireRole } from "@/lib/auth/index.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { getContractStore } from "@/lib/contracts/index.ts";
import { authorizeJob, contractErrorResponse } from "@/lib/contracts/access.ts";
import { selectPackage } from "@/lib/contracts/sign.ts";
import { SelectionError } from "@/lib/contracts/select.ts";
import { TIERS } from "@/lib/scopes/types.ts";
import { DIVISIONS } from "@/lib/leads/types.ts";
import type { Division } from "@/lib/rules.ts";

type Ctx = { params: Promise<{ jobId: string; division: string; tier: string }> };

// Roles: admin, or the job's own estimator. The customer picks this package for this trade.
export async function POST(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  const { jobId, division, tier } = await params;
  if (!(TIERS as readonly string[]).includes(tier)) return Response.json({ error: "unknown_tier" }, { status: 404 });
  if (!(DIVISIONS as readonly string[]).includes(division)) return Response.json({ error: "unknown_division" }, { status: 404 });

  const scopes = getScopeStore();
  const auth = await authorizeJob(scopes, check.user, jobId, "write");
  if ("response" in auth) return auth.response;

  const scope = (await scopes.listScopes(jobId)).find((s) => s.division === division && s.tier === tier);
  if (!scope) return Response.json({ error: "scope_not_saved" }, { status: 400 });

  try {
    const combined = await selectPackage(getContractStore(), jobId, division as Division, tier as (typeof TIERS)[number], check.user.id, scope);
    return Response.json({
      contractCents: combined.contractCents, depositRequiredCents: combined.depositRequiredCents,
      hasSpecialOrder: combined.hasSpecialOrder, selectedDivisions: combined.selectedDivisions,
    });
  } catch (e) {
    if (e instanceof SelectionError) return Response.json({ error: "invalid_selection", message: e.message }, { status: 400 });
    return contractErrorResponse(e);
  }
}
