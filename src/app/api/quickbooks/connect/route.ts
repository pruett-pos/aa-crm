import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/index.ts";
import { getQboConfig } from "@/lib/quickbooks/index.ts";
import { qboAuthorizeUrl } from "@/integrations/quickbooks/oauth.ts";
import { publicUrl } from "@/lib/public-url.ts";

// Role: admin only. Starts the one-time "approve access" trip to Intuit. A random state is kept in a short-lived HTTP-only
// cookie and compared with what Intuit sends back, so only the browser that started the trip can finish it.
export async function GET(req: Request) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const config = getQboConfig();
  if (!config) return NextResponse.redirect(publicUrl("/settings/quickbooks?error=not_configured", req));
  const state = randomBytes(24).toString("hex");
  const res = NextResponse.redirect(qboAuthorizeUrl(config, state));
  res.cookies.set("qbo_oauth_state", state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/quickbooks", maxAge: 600 });
  return res;
}
