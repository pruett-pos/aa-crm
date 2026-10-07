import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/index.ts";
import { getHoverOAuthConfig, getHoverTokenStore } from "@/lib/hover/index.ts";
import { exchangeHoverCode } from "@/integrations/hover/oauth.ts";
import { publicUrl } from "@/lib/public-url.ts";
import { oauthTripIsOurs } from "@/lib/hover/state.ts";

// Role: admin only. Hover sends the admin back here with a one-time code, which is exchanged for tokens (stored encrypted).
// Nothing about the code or the tokens is ever put in a URL or a message shown to the user.
export async function GET(req: Request) {
  const done = (q: string) => {
    const res = NextResponse.redirect(publicUrl(`/settings/hover?${q}`, req));
    res.cookies.set("hover_oauth_state", "", { httpOnly: true, path: "/api/hover", maxAge: 0 });
    return res;
  };
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const oauth = getHoverOAuthConfig();
  if (!oauth) return done("error=not_configured");

  const url = new URL(req.url);
  const cookie = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith("hover_oauth_state="))?.slice("hover_oauth_state=".length) ?? "";
  if (url.searchParams.get("error")) {
    // Hover's own short reason (e.g. access_denied), cut short. It never contains the code or a token.
    const why = [url.searchParams.get("error"), url.searchParams.get("error_description")].filter(Boolean).join(": ").slice(0, 200);
    console.error(`hover callback: Hover returned an error: ${why}`);
    return done("error=denied");
  }
  if (!oauthTripIsOurs(cookie, url.searchParams.get("state"))) return done("error=bad_state");
  const code = url.searchParams.get("code");
  if (!code) return done("error=no_code");
  try {
    const tokens = await exchangeHoverCode(oauth, code, (u, i) => fetch(u, i));
    await getHoverTokenStore().connect(tokens, check.user.id);
    return done("connected=1");
  } catch (e) {
    // The reason only: HoverError messages carry an HTTP status, never the code, tokens or secret.
    console.error(`hover callback failed: ${e instanceof Error ? `${e.name}: ${e.message}` : "unknown"}`);
    return done("error=exchange_failed");
  }
}
