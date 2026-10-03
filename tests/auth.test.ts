import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLoginToken, redeemLoginToken, getSessionUser, destroySession,
  hashSecret, LOGIN_TOKEN_TTL_MS, SESSION_TTL_MS,
} from "../src/lib/auth/core.ts";
import { MemoryAuthStore } from "../src/lib/auth/store.ts";
import { can, CAPABILITIES, ROLES, hasRole } from "../src/lib/auth/roles.ts";
import { allow, resetRateLimits } from "../src/lib/auth/rate-limit.ts";

function setup() {
  const store = new MemoryAuthStore();
  store.users.push(
    { id: "u1", fullName: "AL", email: "al@example.com", role: "admin", active: true },
    { id: "u2", fullName: "Gone", email: "gone@example.com", role: "estimator", active: false },
  );
  return store;
}
const t0 = new Date("2026-10-05T12:00:00Z");
const at = (ms: number) => () => new Date(t0.getTime() + ms);

test("login token: unknown or inactive email gets no token", async () => {
  const store = setup();
  assert.equal(await createLoginToken(store, "nobody@example.com"), null);
  assert.equal(await createLoginToken(store, "gone@example.com"), null);
});

test("login token: email is matched case-insensitively and trimmed", async () => {
  const store = setup();
  assert.ok(await createLoginToken(store, "  AL@Example.com "));
});

test("login token: stored hashed, never raw", async () => {
  const store = setup();
  const made = await createLoginToken(store, "al@example.com", at(0));
  assert.ok(made);
  assert.notEqual(made.token, hashSecret(made.token));
  // raw token must not redeem as a hash
  assert.equal(await store.consumeLoginToken(made.token, t0), null);
});

test("login token: redeems once, then is rejected", async () => {
  const store = setup();
  const made = await createLoginToken(store, "al@example.com", at(0));
  const first = await redeemLoginToken(store, made!.token, at(1000));
  assert.equal(first?.user.id, "u1");
  assert.equal(await redeemLoginToken(store, made!.token, at(2000)), null);
});

test("login token: expires after 15 minutes", async () => {
  const store = setup();
  const made = await createLoginToken(store, "al@example.com", at(0));
  assert.equal(await redeemLoginToken(store, made!.token, at(LOGIN_TOKEN_TTL_MS)), null);
});

test("login token: tampered token is rejected", async () => {
  const store = setup();
  const made = await createLoginToken(store, "al@example.com", at(0));
  assert.equal(await redeemLoginToken(store, made!.token + "x", at(1000)), null);
});

test("login token: user deactivated after the link was sent cannot sign in", async () => {
  const store = setup();
  const made = await createLoginToken(store, "al@example.com", at(0));
  store.users[0].active = false;
  assert.equal(await redeemLoginToken(store, made!.token, at(1000)), null);
});

test("session: valid until 14 days, then expired", async () => {
  const store = setup();
  const made = await createLoginToken(store, "al@example.com", at(0));
  const s = await redeemLoginToken(store, made!.token, at(0));
  assert.equal((await getSessionUser(store, s!.sessionToken, at(SESSION_TTL_MS - 1)))?.id, "u1");
  assert.equal(await getSessionUser(store, s!.sessionToken, at(SESSION_TTL_MS)), null);
});

test("session: missing, unknown, logged-out, or deactivated user is rejected", async () => {
  const store = setup();
  assert.equal(await getSessionUser(store, undefined), null);
  assert.equal(await getSessionUser(store, "nope"), null);
  const made = await createLoginToken(store, "al@example.com", at(0));
  const s = await redeemLoginToken(store, made!.token, at(0));
  store.users[0].active = false;
  assert.equal(await getSessionUser(store, s!.sessionToken, at(1)), null);
  store.users[0].active = true;
  await destroySession(store, s!.sessionToken);
  assert.equal(await getSessionUser(store, s!.sessionToken, at(1)), null);
});

test("roles: capability matrix matches SPEC section 1", () => {
  assert.ok(can("production_manager", "seeScopeMargin")); // decided 2026-10
  assert.ok(can("estimator", "seeScopeMargin"));
  assert.ok(can("admin", "seeScopeMargin"));
  assert.ok(!can("csr", "seeScopeMargin"));
  assert.ok(!can("crew_leader", "seeScopeMargin"));
  assert.ok(!can("accounting", "seeScopeMargin"));
  assert.ok(can("estimator", "seeOwnCommissions"));
  assert.ok(!can("estimator", "seeAllCommissions"));
  assert.ok(can("accounting", "seeAllCommissions"));
  assert.ok(can("csr", "createLeads"));
  assert.ok(!can("estimator", "manageUsers"));
  assert.ok(can("admin", "manageCommissionSettings"));
  assert.ok(!can("accounting", "manageCommissionSettings"));
  assert.ok(can("crew_leader", "requestChangeOrders"));
});

test("roles: every capability only lists known roles", () => {
  for (const roles of Object.values(CAPABILITIES)) {
    for (const r of roles) assert.ok((ROLES as readonly string[]).includes(r));
  }
  assert.ok(hasRole("csr", ["admin", "csr"]));
  assert.ok(!hasRole("crew_leader", ["admin", "csr"]));
});

test("rate limit: blocks after the limit, resets after the window", () => {
  resetRateLimits();
  assert.ok(allow("k", 2, 1000, 0));
  assert.ok(allow("k", 2, 1000, 1));
  assert.ok(!allow("k", 2, 1000, 2));
  assert.ok(allow("k", 2, 1000, 1001));
});
