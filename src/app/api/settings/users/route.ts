import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getUserAdminStore } from "@/lib/users/index.ts";
import { userErrorResponse } from "@/lib/users/http.ts";
import { addUser, listUsers } from "@/lib/users/service.ts";

// Role: admin only (user management).
export async function GET() {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  try {
    return Response.json({ users: await listUsers(getUserAdminStore(), check.user) });
  } catch (e) {
    return userErrorResponse(e);
  }
}

const Body = z.object({
  fullName: z.string().max(200), email: z.string().max(254), phone: z.string().max(40).nullish(), role: z.string().max(40),
  market: z.string().max(40).nullish(), divisions: z.array(z.string().max(40)).max(10).optional(), active: z.boolean().optional(),
});

export async function POST(req: Request) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  if (!allow(`users:${check.user.id}`, 60, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  try {
    return Response.json({ user: await addUser(getUserAdminStore(), check.user, parsed.data) }, { status: 201 });
  } catch (e) {
    return userErrorResponse(e);
  }
}
