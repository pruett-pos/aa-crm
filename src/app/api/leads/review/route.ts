import { requireRole } from "@/lib/auth/index.ts";
import { getLeadStore } from "@/lib/leads/index.ts";

// Roles: CSR and admin. Online leads waiting for the market to be confirmed.
export async function GET() {
  const check = await requireRole("csr", "admin");
  if (!check.ok) return check.response;
  return Response.json({ leads: await getLeadStore().listReviewQueue() });
}
