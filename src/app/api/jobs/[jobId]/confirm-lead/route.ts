import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { getLeadStore } from "@/lib/leads/index.ts";
import { confirmLead } from "@/lib/leads/logic.ts";
import { leadErrorResponse } from "@/lib/leads/http.ts";

type Ctx = { params: Promise<{ jobId: string }> };
const Body = z.object({
  market: z.string().max(30),
  jobType: z.string().max(30).optional(),
  divisions: z.array(z.string().max(30)).max(10),
  overrideEstimatorId: z.string().max(64).nullable().optional(),
});

// Roles: CSR and admin. Confirms the market on an online lead and routes it.
export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("csr", "admin");
  if (!check.ok) return check.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { jobId } = await params;
  try {
    const r = await confirmLead(getLeadStore(), { jobId, ...parsed.data });
    return Response.json(r);
  } catch (e) {
    return leadErrorResponse(e);
  }
}
