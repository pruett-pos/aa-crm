import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/index.ts";
import { getHoverOAuthConfig } from "@/lib/hover/index.ts";
import { hoverAuthorizeUrl } from "@/integrations/hover/oauth.ts";
import { publicUrl } from "@/lib/public-url.ts";

// Role: admin only. Starts the one-time "approve access" trip to Hover. A random value (state) is kept in a short-lived,
// HTTP-only cookie and checked when Hover sends the admin back, so only the person who started the trip can finish it.
export async function GET(req: Request) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const oauth = getHoverOAuthConfig();
  if (!oauth) return NextResponse.redirect(publicUrl("/settings/hover?error=not_configured", req));
  const state = randomBytes(24).toString("hex");
  const res = NextResponse.redirect(hoverAuthorizeUrl(oauth, state));
  res.cookies.set("hover_oauth_state", state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/hover", maxAge: 600 });
  return res;
}
