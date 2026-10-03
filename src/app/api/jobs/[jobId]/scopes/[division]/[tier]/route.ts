import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { getContractStore } from "@/lib/contracts/index.ts";
import { ScopeInputError, canWriteScopes, computeScope, toView } from "@/lib/scopes/service.ts";
import { TIERS } from "@/lib/scopes/types.ts";
import { DIVISIONS } from "@/lib/leads/types.ts";
import type { Division } from "@/lib/rules.ts";

type Ctx = { params: Promise<{ jobId: string; division: string; tier: string }> };

// Prices are deliberately absent: the server computes every price from cost and target margin.
const Item = z.object({
  kind: z.enum(["material", "labor", "misc"]),
  productId: z.string().max(64).optional(),
  description: z.string().max(200).optional(),
  quantity: z.number().finite(),
  unitCostCents: z.number().int().optional(),
  color: z.string().max(60).optional(),
});
const Body = z.object({
  title: z.string().min(1).max(120),
  targetMarginBps: z.number().int(),
  items: z.array(Item).max(200),
});

// Roles: admin, or the job's own estimator. One set of packages per trade on the job.
export async function PUT(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  const { user } = check;
  const { jobId, division, tier } = await params;
  if (!(TIERS as readonly string[]).includes(tier)) return Response.json({ error: "unknown_tier" }, { status: 404 });
  if (!(DIVISIONS as readonly string[]).includes(division)) return Response.json({ error: "unknown_division" }, { status: 404 });

  const store = getScopeStore();
  const job = await store.getJob(jobId);
  if (!job) return Response.json({ error: "not_found" }, { status: 404 });
  if (!canWriteScopes(user, job)) return Response.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });

  // Prices are locked once the customer has signed.
  const contracts = getContractStore();
  if (await contracts.hasSignedContract(job.id)) {
    return Response.json({ error: "contract_signed", message: "This job has a signed contract" }, { status: 409 });
  }

  try {
    const computed = computeScope(
      { ...parsed.data, division: division as Division, tier: tier as (typeof TIERS)[number] },
      await store.listProducts(), job.divisions,
    );
    const saved = await store.saveScope(job.id, computed);
    // Editing the package the customer picked voids that trade's selection and any unsigned contract.
    await contracts.clearSelectionIfSelected(job.id, division as Division, tier as (typeof TIERS)[number]);
    const estimatorOwnTruck = job.estimatorId ? await store.getEstimatorOwnTruck(job.estimatorId) : false;
    return Response.json(toView({ ...saved, selected: false }, user.role, {
      isOwnJobEstimator: job.estimatorId === user.id, estimatorOwnTruck,
    }));
  } catch (e) {
    if (e instanceof ScopeInputError) return Response.json({ error: "invalid_scope", message: e.message }, { status: 400 });
    throw e;
  }
}
