import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { getQboStore, triggerQboSync } from "@/lib/quickbooks/index.ts";
import { acknowledgeMismatch, retryJob } from "@/lib/quickbooks/logic.ts";

const Body = z.object({ action: z.enum(["retry", "review"]) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Roles: admin and accounting. Retry a failed push, or mark a total mismatch as reviewed.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const check = await requireRole("admin", "accounting");
  if (!check.ok) return check.response;
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !UUID.test(id)) return Response.json({ error: "invalid_body" }, { status: 400 });
  const store = getQboStore();
  const ok = parsed.data.action === "retry" ? await retryJob(store, id) : await acknowledgeMismatch(store, id);
  if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
  if (parsed.data.action === "retry") triggerQboSync();
  return Response.json({ ok: true });
}
