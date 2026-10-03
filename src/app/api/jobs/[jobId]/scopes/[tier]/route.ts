import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { ScopeInputError, canWriteScopes, computeScope, toView } from "@/lib/scopes/service.ts";
import { TIERS } from "@/lib/scopes/types.ts";

type Ctx = { params: Promise<{ jobId: string; tier: string }> };

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

// Roles: admin, or the job's own estimator.
export async function PUT(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  const { user } = check;
  const { jobId, tier } = await params;
  if (!(TIERS as readonly string[]).includes(tier)) {
    return Response.json({ error: "unknown_tier" }, { status: 404 });
  }

  const store = getScopeStore();
  const job = await store.getJob(jobId);
  if (!job) return Response.json({ error: "not_found" }, { status: 404 });
  if (!canWriteScopes(user, job)) return Response.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });

  try {
    const computed = computeScope({ ...parsed.data, tier: tier as (typeof TIERS)[number] }, await store.listProducts());
    const saved = await store.saveScope(job.id, computed);
    const estimatorOwnTruck = job.estimatorId ? await store.getEstimatorOwnTruck(job.estimatorId) : false;
    return Response.json(toView(saved, user.role, {
      isOwnJobEstimator: job.estimatorId === user.id, estimatorOwnTruck,
    }));
  } catch (e) {
    if (e instanceof ScopeInputError) return Response.json({ error: "invalid_scope", message: e.message }, { status: 400 });
    throw e;
  }
}
