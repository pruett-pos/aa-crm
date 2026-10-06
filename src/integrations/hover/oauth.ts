// Hover OAuth 2.0 (authorization code + refresh), per developers.hover.to. A person at A&A approves access ONCE
// in the browser ("Connect Hover"); after that the CRM keeps itself signed in with the refresh token.
// Access tokens last 2 hours. The refresh token ROTATES: each refresh returns a new one and the old one stops working,
// so a refresh must be saved right away and never run twice at once (see src/lib/hover/tokens.ts).
import { HoverError, type FetchLike } from "./client.ts";

const DEFAULT_BASE = "https://hover.to";

export type HoverOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string; baseUrl?: string };
export type HoverTokens = { accessToken: string; refreshToken: string; expiresAt: Date; ownerId: string | null };

/** Credentials from the environment, or null when Hover isn't set up (the feature then stays off). */
export function hoverOAuthFromEnv(env: Record<string, string | undefined> = process.env): HoverOAuthConfig | null {
  const clientId = env.HOVER_CLIENT_ID?.trim(), clientSecret = env.HOVER_CLIENT_SECRET?.trim(), redirectUri = env.HOVER_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri, baseUrl: env.HOVER_API_BASE?.trim() || undefined };
}

const base = (c: HoverOAuthConfig) => (c.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");

/** Where to send the admin to approve access. `state` ties the return trip to the person who started it. */
export function hoverAuthorizeUrl(c: HoverOAuthConfig, state: string): string {
  const q = new URLSearchParams({ response_type: "code", client_id: c.clientId, redirect_uri: c.redirectUri, state });
  return `${base(c)}/oauth/authorize?${q.toString()}`;
}

async function tokenCall(c: HoverOAuthConfig, body: Record<string, string>, doFetch: FetchLike, now: Date, timeoutMs = 10_000): Promise<HoverTokens> {
  let res: Response;
  try {
    res = await doFetch(`${base(c)}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, ...body }), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HoverError("network", "Could not reach Hover");
  }
  if (!res.ok) {
    // A bad or already-used code or refresh token (400/401) means a person has to connect again. Nothing from the reply is kept.
    throw new HoverError(res.status === 400 || res.status === 401 ? "auth" : res.status >= 500 ? "server" : "bad_request", `Hover refused the sign-in (HTTP ${res.status})`);
  }
  let j: Record<string, unknown>;
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new HoverError("server", "Unexpected response from Hover");
  }
  const access = j.access_token, refresh = j.refresh_token, ttl = Number(j.expires_in);
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh || !Number.isFinite(ttl) || ttl <= 0) {
    throw new HoverError("server", "Unexpected response from Hover");
  }
  return { accessToken: access, refreshToken: refresh, expiresAt: new Date(now.getTime() + ttl * 1000), ownerId: j.owner_id === undefined || j.owner_id === null ? null : String(j.owner_id) };
}

export const exchangeHoverCode = (c: HoverOAuthConfig, code: string, doFetch: FetchLike, now: Date = new Date()) =>
  tokenCall(c, { grant_type: "authorization_code", code, redirect_uri: c.redirectUri }, doFetch, now);

export const refreshHoverTokens = (c: HoverOAuthConfig, refreshToken: string, doFetch: FetchLike, now: Date = new Date()) =>
  tokenCall(c, { grant_type: "refresh_token", refresh_token: refreshToken }, doFetch, now);
