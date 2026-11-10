import { NextResponse, type NextRequest } from "next/server";
import { publicUrl } from "./lib/public-url.ts";
import { buildCsp, newNonce } from "./lib/security-headers.ts";

const SESSION_COOKIE = "aa_session";
// /api/leads/website is called by the website's form handler. It has its own secret-header check.
// /api/health is called by Railway and uptime monitors; it returns only ok or down.
const PUBLIC_PREFIXES = ["/login", "/api/auth/", "/api/leads/website", "/api/health"];

// WHY THE PROXY ONLY CHECKS THAT A SESSION COOKIE EXISTS (and does not look the session up):
// A real check means a database read on every request, including every page and asset, and this runs before the
// route does. The real gate is in the routes, and it cannot be skipped by accident:
//   - every API route calls requireRole(...) or getCurrentUser() (or is on the short public list in
//     tests/route-guards.test.ts, each with its own check), and that test fails the build if a route has neither;
//   - every page calls getCurrentUser() and redirects to /login.
// Both validate the cookie against the database (hash lookup, expiry, user still active), so a forged, expired or
// revoked cookie gets the same 401/redirect, one step later. The proxy's job is the cheap first gate plus the CSP.
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const nonce = newNonce();
  const csp = buildCsp(nonce);

  const withHeaders = (res: NextResponse) => {
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };

  if (!PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) && !req.cookies.get(SESSION_COOKIE)) {
    if (pathname.startsWith("/api/")) return withHeaders(NextResponse.json({ error: "unauthenticated" }, { status: 401 }));
    return withHeaders(NextResponse.redirect(publicUrl("/login", req)));
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  return withHeaders(NextResponse.next({ request: { headers: requestHeaders } }));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
