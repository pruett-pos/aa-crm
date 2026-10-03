import { cookies } from "next/headers";
import { z } from "zod";
import { redeemLoginToken } from "@/lib/auth/core.ts";
import { getStore, SESSION_COOKIE } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";

const Body = z.object({ token: z.string().min(20).max(200) });

// Public route (sign-in). POST, not GET, so email link scanners can't use up the one-time token.
export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!allow(`verify:${ip}`, 30, 15 * 60 * 1000)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_link" }, { status: 400 });

  const result = await redeemLoginToken(getStore(), parsed.data.token);
  if (!result) return Response.json({ error: "invalid_link" }, { status: 400 });

  (await cookies()).set(SESSION_COOKIE, result.sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: result.expiresAt,
  });
  return Response.json({ ok: true });
}
