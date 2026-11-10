import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getUserAdminStore } from "@/lib/users/index.ts";
import { userErrorResponse } from "@/lib/users/http.ts";
import { changeUser } from "@/lib/users/service.ts";

// Role: admin only. Change a person's details, role, divisions, or turn them off and on (active).
const Body = z.object({
  fullName: z.string().max(200).optional(), email: z.string().max(254).optional(), phone: z.string().max(40).nullish(),
  role: z.string().max(40).optional(), market: z.string().max(40).nullish(), divisions: z.array(z.string().max(40)).max(10).optional(),
  active: z.boolean().optional(),
}).strict();

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  if (!allow(`users:${check.user.id}`, 60, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { id } = await ctx.params;
  try {
    return Response.json({ user: await changeUser(getUserAdminStore(), check.user, id, parsed.data) });
  } catch (e) {
    return userErrorResponse(e);
  }
}
