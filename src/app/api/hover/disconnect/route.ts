import { requireRole } from "@/lib/auth/index.ts";
import { getHoverTokenStore } from "@/lib/hover/index.ts";

// Role: admin only. Forgets the stored Hover tokens (the CRM can no longer reach Hover until an admin connects again).
export async function POST() {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  await getHoverTokenStore().disconnect();
  return Response.json({ ok: true });
}
