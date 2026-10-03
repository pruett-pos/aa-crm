import { requireRole } from "@/lib/auth/index.ts";
import { getCommissionStore } from "@/lib/commission/index.ts";
import { canViewStatement, statement } from "@/lib/commission/logic.ts";
import { commissionErrorResponse } from "@/lib/commission/http.ts";

// Roles: an estimator sees only their own statement; admin and accounting can see any estimator's.
export async function GET(req: Request) {
  const check = await requireRole("estimator", "admin", "accounting");
  if (!check.ok) return check.response;
  const { user } = check;
  const asked = new URL(req.url).searchParams.get("estimatorId");
  const estimatorId = user.role === "estimator" ? (asked ?? user.id) : asked;
  if (!estimatorId) return Response.json({ error: "estimator_invalid" }, { status: 400 });
  if (!canViewStatement(user, estimatorId)) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    return Response.json(await statement(getCommissionStore(), estimatorId));
  } catch (e) {
    return commissionErrorResponse(e);
  }
}
