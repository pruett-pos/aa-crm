import { requireRole } from "@/lib/auth/index.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { getContractStore } from "@/lib/contracts/index.ts";
import { authorizeJob, contractErrorResponse } from "@/lib/contracts/access.ts";
import { prepareContract } from "@/lib/contracts/sign.ts";

type Ctx = { params: Promise<{ jobId: string }> };

// Roles: admin, or the job's own estimator. Generates the unsigned contract PDF for the selected package.
export async function POST(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  const { jobId } = await params;
  const auth = await authorizeJob(getScopeStore(), check.user, jobId, "write");
  if ("response" in auth) return auth.response;
  try {
    const doc = await prepareContract(getContractStore(), jobId);
    return Response.json({ documentId: doc.id, status: doc.status });
  } catch (e) {
    return contractErrorResponse(e);
  }
}
