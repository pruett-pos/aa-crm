import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getEstimatingDeps } from "@/lib/estimating/index.ts";
import { estimatingErrorResponse } from "@/lib/estimating/http.ts";
import { buildScopesFromMeasurements } from "@/lib/estimating/service.ts";

type Ctx = { params: Promise<{ jobId: string }> };
const Body = z.object({
  division: z.string().max(30),
  wastePct: z.number().finite().min(0).max(30).default(10),
  replace: z.boolean().default(false),
});

// Roles: admin, or the job's own estimator (checked again in the service). Builds the Good, Better and Best scopes from the
// job's current measurements and the assembly settings, through the same pricing as a hand-built scope. The client sends no
// prices. Existing scopes are only replaced when `replace` is true.
export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  if (!allow(`frommeas:${check.user.id}`, 30, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { jobId } = await params;
  try {
    return Response.json(await buildScopesFromMeasurements(getEstimatingDeps(), check.user, { jobId, ...parsed.data }), { status: 201 });
  } catch (e) {
    return estimatingErrorResponse(e);
  }
}
