import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/index.ts";
import { getHoverOAuthConfig, getHoverTokenStore } from "@/lib/hover/index.ts";
import { exchangeHoverCode } from "@/integrations/hover/oauth.ts";

const safeEqual = (a: string, b: string) => a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Role: admin only. Hover sends the admin back here with a one-time code, which is exchanged for tokens (stored encrypted).
// Nothing about the code or the tokens is ever put in a URL or a message shown to the user.
export async function GET(req: Request) {
  const done = (q: string) => {
    const res = NextResponse.redirect(new URL(`/settings/hover?${q}`, req.url));
    res.cookies.set("hover_oauth_state", "", { httpOnly: true, path: "/api/hover", maxAge: 0 });
    return res;
  };
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const oauth = getHoverOAuthConfig();
  if (!oauth) return done("error=not_configured");

  const url = new URL(req.url);
  const cookie = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith("hover_oauth_state="))?.slice("hover_oauth_state=".length) ?? "";
  if (url.searchParams.get("error")) return done("error=denied");
  if (!safeEqual(cookie, url.searchParams.get("state") ?? "")) return done("error=bad_state");
  const code = url.searchParams.get("code");
  if (!code) return done("error=no_code");
  try {
    const tokens = await exchangeHoverCode(oauth, code, (u, i) => fetch(u, i));
    await getHoverTokenStore().connect(tokens, check.user.id);
    return done("connected=1");
  } catch {
    return done("error=exchange_failed");
  }
}
