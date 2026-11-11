import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/index.ts";
import { getQboConfig, getQboStore, getQboTokenStore, triggerQboSync } from "@/lib/quickbooks/index.ts";
import { createQboClient } from "@/integrations/quickbooks/client.ts";
import { exchangeQboCode, qboApiBase, qboStateMatches } from "@/integrations/quickbooks/oauth.ts";
import { publicUrl } from "@/lib/public-url.ts";

// Role: admin only. Intuit sends the admin back here with a one-time code, the state, and the company's realmId.
// The state must match the cookie; the code is exchanged for tokens (stored encrypted). Nothing sensitive goes in a URL.
export async function GET(req: Request) {
  const done = (q: string) => {
    const res = NextResponse.redirect(publicUrl(`/settings/quickbooks?${q}`, req));
    res.cookies.set("qbo_oauth_state", "", { httpOnly: true, path: "/api/quickbooks", maxAge: 0 });
    return res;
  };
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const config = getQboConfig();
  if (!config) return done("error=not_configured");

  const url = new URL(req.url);
  const cookie = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith("qbo_oauth_state="))?.slice("qbo_oauth_state=".length) ?? "";
  if (url.searchParams.get("error")) {
    console.error(`quickbooks callback: Intuit returned an error: ${(url.searchParams.get("error") ?? "").slice(0, 100)}`);
    return done("error=denied");
  }
  if (!qboStateMatches(cookie, url.searchParams.get("state"))) return done("error=bad_state");
  const code = url.searchParams.get("code"), realmId = url.searchParams.get("realmId");
  if (!code || !realmId || !/^\d{5,25}$/.test(realmId)) return done("error=no_code");
  try {
    const tokens = await exchangeQboCode(config, code, realmId, (u, i) => fetch(u, i));
    const companyName = await createQboClient({
      apiBase: qboApiBase(config.environment), realmId, getAccessToken: async () => tokens.accessToken,
    }).companyName();
    await getQboTokenStore().connect(tokens, check.user.id);
    await getQboStore().saveConnection({ realmId, companyName, environment: config.environment }, new Date());
    triggerQboSync();
    return done("connected=1");
  } catch (e) {
    console.error(`quickbooks callback failed: ${e instanceof Error ? `${e.name}: ${e.message}` : "unknown"}`);
    return done("error=exchange_failed");
  }
}
