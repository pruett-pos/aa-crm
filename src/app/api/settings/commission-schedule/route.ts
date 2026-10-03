import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { getCommissionStore } from "@/lib/commission/index.ts";
import { setSchedule } from "@/lib/commission/logic.ts";
import { commissionErrorResponse } from "@/lib/commission/http.ts";

const Body = z.object({ cadence: z.string().max(20), anchorDate: z.string().max(10).nullable().optional() });

// Roles: admin only.
export async function GET() {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  return Response.json({ schedule: await getCommissionStore().getSchedule() });
}

export async function PUT(req: Request) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  try {
    const s = await setSchedule(getCommissionStore(), { cadence: parsed.data.cadence, anchorDate: parsed.data.anchorDate ?? null, userId: check.user.id });
    return Response.json({ schedule: s });
  } catch (e) {
    return commissionErrorResponse(e);
  }
}
