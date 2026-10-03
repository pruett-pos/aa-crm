import { z } from "zod";
import { createLoginToken, normalizeEmail } from "@/lib/auth/core.ts";
import { getStore } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { sendLoginLink } from "@/integrations/resend/index.ts";

const Body = z.object({ email: z.string().email().max(254) });
const WINDOW_MS = 15 * 60 * 1000;

// Public route (sign-in). Always answers { ok: true } for a valid email so
// the response never reveals whether an account exists.
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_email" }, { status: 400 });

  const email = normalizeEmail(parsed.data.email);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!allow(`email:${email}`, 5, WINDOW_MS) || !allow(`ip:${ip}`, 20, WINDOW_MS)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const made = await createLoginToken(getStore(), email);
  if (made) {
    const base = process.env.APP_URL ?? new URL(req.url).origin;
    await sendLoginLink(made.user.email, `${base}/login/confirm?token=${encodeURIComponent(made.token)}`);
  }
  return Response.json({ ok: true });
}
