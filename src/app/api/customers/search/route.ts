import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getLeadStore } from "@/lib/leads/index.ts";
import { searchCustomers } from "@/lib/leads/logic.ts";
import { leadErrorResponse } from "@/lib/leads/http.ts";

// Roles: CSR and admin. Customer contact details are not shown to anyone else here.
export async function GET(req: Request) {
  const check = await requireRole("csr", "admin");
  if (!check.ok) return check.response;
  if (!allow(`search:${check.user.id}`, 120, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const q = new URL(req.url).searchParams.get("q") ?? "";
  try {
    return Response.json({ customers: await searchCustomers(getLeadStore(), q) });
  } catch (e) {
    return leadErrorResponse(e);
  }
}
