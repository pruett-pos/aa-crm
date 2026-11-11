import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { syncNow } from "@/lib/quickbooks/index.ts";

// Roles: admin and accounting ("Sync now"). Queues anything new and works through what is due.
export async function POST() {
  const check = await requireRole("admin", "accounting");
  if (!check.ok) return check.response;
  if (!allow(`qbo-sync:${check.user.id}`, 20, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const r = await syncNow(50);
  if (!r) return Response.json({ error: "not_connected" }, { status: 409 });
  return Response.json(r);
}
