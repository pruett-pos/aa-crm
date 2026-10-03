import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { getContractStore } from "@/lib/contracts/index.ts";
import { authorizeJob, contractErrorResponse } from "@/lib/contracts/access.ts";
import { changeDivisions } from "@/lib/contracts/sign.ts";

type Ctx = { params: Promise<{ jobId: string }> };
const Body = z.object({ action: z.enum(["add", "remove"]), division: z.string().max(30) });

// Roles: admin, or the job's own estimator. Add a trade to the job or drop one before the contract is signed.
// Dropping a trade deletes that trade's unsigned estimates and recalculates the job's totals.
export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  if (!allow(`divisions:${check.user.id}`, 60, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { jobId } = await params;
  const auth = await authorizeJob(getScopeStore(), check.user, jobId, "write");
  if ("response" in auth) return auth.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  try {
    const divisions = await changeDivisions(getContractStore(), { jobId, ...parsed.data });
    return Response.json({ divisions });
  } catch (e) {
    return contractErrorResponse(e);
  }
}
