import { requireRole } from "@/lib/auth/index.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { getContractStore } from "@/lib/contracts/index.ts";
import { authorizeJob, contractErrorResponse } from "@/lib/contracts/access.ts";
import { selectPackage } from "@/lib/contracts/sign.ts";
import { SelectionError } from "@/lib/contracts/select.ts";
import { TIERS } from "@/lib/scopes/types.ts";

type Ctx = { params: Promise<{ jobId: string; tier: string }> };

// Roles: admin, or the job's own estimator. The customer picks this package.
export async function POST(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  const { jobId, tier } = await params;
  if (!(TIERS as readonly string[]).includes(tier)) return Response.json({ error: "unknown_tier" }, { status: 404 });

  const scopes = getScopeStore();
  const auth = await authorizeJob(scopes, check.user, jobId, "write");
  if ("response" in auth) return auth.response;

  const scope = (await scopes.listScopes(jobId)).find((s) => s.tier === tier);
  if (!scope) return Response.json({ error: "scope_not_saved" }, { status: 400 });

  try {
    const sel = await selectPackage(getContractStore(), jobId, tier as (typeof TIERS)[number], check.user.id, scope);
    return Response.json({
      contractCents: sel.contractCents, depositRequiredCents: sel.depositRequiredCents, stage: sel.stage,
    });
  } catch (e) {
    if (e instanceof SelectionError) return Response.json({ error: "invalid_selection", message: e.message }, { status: 400 });
    return contractErrorResponse(e);
  }
}
