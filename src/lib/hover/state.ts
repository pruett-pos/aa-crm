import { timingSafeEqual } from "node:crypto";

const same = (a: string, b: string) => a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Is this callback the end of a trip THIS browser started? Hover's authorize step takes only response_type, client_id and
 * redirect_uri, and sends back only ?code= (it does not echo `state`), so we cannot require one. What we can require:
 * the short-lived HTTP-only cookie set when the admin pressed Connect Hover (proves this browser began a trip in the last
 * 10 minutes), plus an admin session (checked by the route). If a `state` does come back, it must match the cookie.
 */
export function oauthTripIsOurs(cookie: string, stateParam: string | null): boolean {
  if (!cookie) return false;
  if (stateParam === null) return true;
  return same(cookie, stateParam);
}
