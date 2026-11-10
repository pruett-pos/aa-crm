// QuickBooks Online OAuth 2.0 (authorization code + refresh), per developer.intuit.com. An admin approves access ONCE in the
// browser ("Connect QuickBooks"); the CRM then keeps itself signed in with the refresh token. Access tokens last 1 hour; the
// refresh token (about 100 days) is replaced at each refresh, so the new one is saved at once (see src/lib/quickbooks/tokens.ts).
import { timingSafeEqual } from "node:crypto";
import { QboError } from "./errors.ts";
import type { FetchLike } from "./client.ts";

export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
export const QBO_CALLBACK_PATH = "/api/quickbooks/callback";
const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

export type QboEnvironment = "sandbox" | "production";
export type QboConfig = { clientId: string; clientSecret: string; redirectUri: string; environment: QboEnvironment };
export type QboTokens = { accessToken: string; refreshToken: string; expiresAt: Date; realmId: string | null };

/** Credentials from the environment, or null when QuickBooks isn't set up (the feature then stays off). */
export function qboConfigFromEnv(env: Record<string, string | undefined> = process.env): QboConfig | null {
  const clientId = env.QBO_CLIENT_ID?.trim(), clientSecret = env.QBO_CLIENT_SECRET?.trim(), redirectUri = env.QBO_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  const e = (env.QBO_ENVIRONMENT?.trim() || "sandbox").toLowerCase();
  if (e !== "sandbox" && e !== "production") return null;     // a typo must not silently point at the wrong company
  return { clientId, clientSecret, redirectUri, environment: e };
}

export const qboApiBase = (e: QboEnvironment) =>
  e === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";

/** Where to send the admin to approve access. `state` ties the return trip to the browser that started it. */
export function qboAuthorizeUrl(c: QboConfig, state: string): string {
  const q = new URLSearchParams({ client_id: c.clientId, response_type: "code", scope: QBO_SCOPE, redirect_uri: c.redirectUri, state });
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

/** The return trip is ours only if the state Intuit echoes equals the one kept in this browser's short-lived cookie. */
export function qboStateMatches(cookie: string, stateParam: string | null): boolean {
  if (!cookie || !stateParam || cookie.length !== stateParam.length) return false;
  return timingSafeEqual(Buffer.from(cookie), Buffer.from(stateParam));
}

const basic = (c: QboConfig) => `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`;

async function tokenCall(c: QboConfig, form: Record<string, string>, doFetch: FetchLike, now: Date, realmId: string | null): Promise<QboTokens> {
  let res: Response;
  try {
    res = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: basic(c), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new QboError("network", "Could not reach QuickBooks");
  }
  if (!res.ok) {
    // 400 invalid_grant / 401: the code or refresh token is spent or revoked. Nothing from the reply body is kept.
    throw new QboError(res.status === 400 || res.status === 401 ? "auth" : res.status >= 500 ? "server" : "validation", `QuickBooks refused the sign-in (HTTP ${res.status})`);
  }
  let j: Record<string, unknown>;
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new QboError("server", "Unexpected response from QuickBooks");
  }
  const access = j.access_token, refresh = j.refresh_token, ttl = Number(j.expires_in);
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh || !Number.isFinite(ttl) || ttl <= 0) {
    throw new QboError("server", "Unexpected response from QuickBooks");
  }
  return { accessToken: access, refreshToken: refresh, expiresAt: new Date(now.getTime() + ttl * 1000), realmId };
}

export const exchangeQboCode = (c: QboConfig, code: string, realmId: string, doFetch: FetchLike, now: Date = new Date()) =>
  tokenCall(c, { grant_type: "authorization_code", code, redirect_uri: c.redirectUri }, doFetch, now, realmId);

export const refreshQboTokens = (c: QboConfig, refreshToken: string, realmId: string | null, doFetch: FetchLike, now: Date = new Date()) =>
  tokenCall(c, { grant_type: "refresh_token", refresh_token: refreshToken }, doFetch, now, realmId);

/** Tell Intuit to forget the grant (used by Disconnect). Best effort: failure never blocks disconnecting. */
export async function revokeQboToken(c: QboConfig, refreshToken: string, doFetch: FetchLike): Promise<boolean> {
  try {
    const res = await doFetch(REVOKE_URL, {
      method: "POST", headers: { Authorization: basic(c), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ token: refreshToken }), signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
