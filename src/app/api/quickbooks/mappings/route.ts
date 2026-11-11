import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { getQboStore } from "@/lib/quickbooks/index.ts";
import { DIVISIONS_QBO, LEAD_SOURCES_QBO } from "@/lib/quickbooks/mappings.ts";

// Role: admin only. A blank name means "use the default" (the source or division name) and is not stored.
const Name = z.string().trim().max(100).refine((s) => !/[:"\t\r\n]/.test(s), "No colons, quotes or line breaks");
const Body = z.object({
  classes: z.record(z.string(), Name),
  items: z.record(z.string(), Name),
});

export async function PUT(req: Request) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const keep = (m: Record<string, string>, allowed: readonly string[]) =>
    Object.fromEntries(Object.entries(m).filter(([k, v]) => allowed.includes(k) && v !== ""));
  const store = getQboStore();
  await store.setClassMap(keep(parsed.data.classes, LEAD_SOURCES_QBO));
  await store.setItemMap(keep(parsed.data.items, DIVISIONS_QBO));
  return Response.json({ ok: true });
}
