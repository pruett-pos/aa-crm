import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { getLeadStore } from "@/lib/leads/index.ts";
import { setMarketingSpend } from "@/lib/leads/logic.ts";
import { leadErrorResponse } from "@/lib/leads/http.ts";

const Body = z.object({ source: z.string().max(30), month: z.string().max(10), amount: z.string().max(20) });

// Roles: admin only (commission and company settings).
export async function GET(req: Request) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const url = new URL(req.url);
  const re = /^\d{4}-\d{2}$/;
  const from = url.searchParams.get("from") ?? "", to = url.searchParams.get("to") ?? "";
  if (!re.test(from) || !re.test(to)) return Response.json({ error: "month_invalid" }, { status: 400 });
  return Response.json({ spend: await getLeadStore().listSpend(from, to) });
}

export async function PUT(req: Request) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  try {
    const r = await setMarketingSpend(getLeadStore(), { source: parsed.data.source, month: parsed.data.month, amountText: parsed.data.amount });
    return Response.json(r);
  } catch (e) {
    return leadErrorResponse(e);
  }
}
