import { NextResponse, type NextRequest } from "next/server";
import { publicUrl } from "./lib/public-url.ts";

const SESSION_COOKIE = "aa_session";
// /api/leads/website is called by the website's form handler. It has its own secret-header check.
const PUBLIC_PREFIXES = ["/login", "/api/auth/", "/api/leads/website"];

// Cheap gate: no session cookie means no access. The cookie is only checked for
// presence here; routes and pages validate it against the database.
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (req.cookies.get(SESSION_COOKIE)) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  return NextResponse.redirect(publicUrl("/login", req));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
