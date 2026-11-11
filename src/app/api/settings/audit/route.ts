import { requireRole } from "@/lib/auth/index.ts";
import { getAuditStore } from "@/lib/audit/index.ts";

// Role: admin only. The newest audit entries (users and settings changes).
export async function GET(req: Request) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const limit = Math.min(500, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 100));
  return Response.json({ entries: await getAuditStore().list(limit) });
}
