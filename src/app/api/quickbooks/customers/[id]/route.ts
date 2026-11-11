import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { getQboStore } from "@/lib/quickbooks/index.ts";
import { dismissDuplicateFlag, linkToExistingCustomer } from "@/lib/quickbooks/logic.ts";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), qboId: z.string().regex(/^\d{1,20}$/) }),
  z.object({ action: z.literal("dismiss") }),
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Role: admin only. Resolve a "possible duplicate": link the CRM customer to the existing QuickBooks customer QuickBooks
// showed as a name match (only those can be chosen), or keep the new QuickBooks customer as a different person.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !UUID.test(id)) return Response.json({ error: "invalid_body" }, { status: 400 });
  const store = getQboStore();
  const b = parsed.data;
  const ok = b.action === "link" ? await linkToExistingCustomer(store, id, b.qboId) : await dismissDuplicateFlag(store, id);
  return ok ? Response.json({ ok: true }) : Response.json({ error: "not_found" }, { status: 404 });
}
