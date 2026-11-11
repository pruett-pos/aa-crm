// Every API route must check the signed-in user's role, except a short, reviewed list of public routes that have a
// different gate. This is why src/proxy.ts can get away with only checking that a session cookie exists: the
// routes do the real check, and this test fails the build if one forgets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const API = new URL("../src/app/api", import.meta.url).pathname;
const SRC = new URL("../src", import.meta.url).pathname;

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? routes(p) : n === "route.ts" ? [p] : [];
  });
}
const rel = (p: string) => relative(SRC, p);

// Public on purpose, each with its own gate.
const PUBLIC: Record<string, RegExp> = {
  "app/api/auth/request-link/route.ts": /allowPersistent/,       // sign-in request: rate limited, same answer for every email
  "app/api/auth/verify/route.ts": /redeemLoginToken/,            // one-time token
  "app/api/auth/logout/route.ts": /destroySession/,              // ends the caller's own session
  "app/api/leads/website/route.ts": /WEBSITE_FORM_SECRET|websiteFormSecret|x-website-form-secret/i, // shared secret header
  "app/api/health/route.ts": /checkHealth/,                      // returns only ok / down
};

test("every API route checks the user's role, or is on the reviewed public list with its own gate", () => {
  const found = routes(API);
  assert.ok(found.length > 40, "found the routes");
  const problems: string[] = [];
  for (const f of found) {
    const src = readFileSync(f, "utf8");
    const r = rel(f);
    if (PUBLIC[r]) {
      if (!PUBLIC[r].test(src)) problems.push(`${r}: public route is missing its own gate`);
      continue;
    }
    if (!/requireRole\(|getCurrentUser\(/.test(src)) problems.push(`${r}: no requireRole()/getCurrentUser() call`);
  }
  assert.deepEqual(problems, []);
});

test("the public list contains only routes that still exist", () => {
  const found = new Set(routes(API).map(rel));
  for (const r of Object.keys(PUBLIC)) assert.ok(found.has(r), `${r} no longer exists; remove it from the public list`);
});

test("user management and audit routes are admin only", () => {
  for (const f of ["app/api/settings/users/route.ts", "app/api/settings/users/[id]/route.ts", "app/api/settings/audit/route.ts"]) {
    const src = readFileSync(join(SRC, f), "utf8");
    const calls = [...src.matchAll(/requireRole\(([^)]*)\)/g)].map((m) => m[1].replace(/\s/g, ""));
    assert.ok(calls.length >= 1, f);
    assert.ok(calls.every((c) => c === '"admin"'), `${f} must use requireRole("admin") only, found ${calls}`);
  }
});

test("every method handler on a guarded route checks the role itself", () => {
  const problems: string[] = [];
  for (const f of routes(API)) {
    const r = rel(f);
    if (PUBLIC[r]) continue;
    const src = readFileSync(f, "utf8");
    const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)];
    for (let i = 0; i < handlers.length; i++) {
      const body = src.slice(handlers[i].index!, handlers[i + 1]?.index ?? src.length);
      if (!/requireRole\(|getCurrentUser\(/.test(body)) problems.push(`${r}: ${handlers[i][1]} has no role check`);
    }
  }
  assert.deepEqual(problems, []);
});
