import { test } from "node:test";
import assert from "node:assert/strict";
import { HoverError, createHoverClient, type FetchLike } from "../src/integrations/hover/client.ts";
import { exchangeHoverCode, hoverAuthorizeUrl, hoverOAuthFromEnv, refreshHoverTokens, type HoverOAuthConfig } from "../src/integrations/hover/oauth.ts";
import { MemoryHoverTokenStore } from "../src/lib/hover/memory-store.ts";
import { createHoverTokenProvider } from "../src/lib/hover/tokens.ts";

const TOKEN = "hover-access-secret-777";
const OAUTH: HoverOAuthConfig = { clientId: "cid-123", clientSecret: "csecret-456", redirectUri: "http://localhost:3000/api/hover/callback" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function fake(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: FetchLike = async (url, init = {}) => { calls.push({ url, init }); return responder(url, init); };
  return { f, calls };
}
const T0 = new Date("2026-10-14T17:00:00Z");
const tokenBody = (n: number, over: Record<string, unknown> = {}) => ({ access_token: `acc${n}`, refresh_token: `ref${n}`, expires_in: 7200, token_type: "Bearer", scope: "all", owner_id: 42, ...over });

const hoverJob = {
  id: 17344154, name: "Miller roof", reconstruction_state: "completed", external_identifier: null,
  address: { location_line_1: "100 Example Rd", location_line_2: null, city: "West Plains", region: "MO", postal_code: "65775", country: "US" },
  models: [{ id: 17338410, name: null, state: "complete", deliverable: "complete" }, { id: 17338999, state: "uploading" }],
};
const client = (f: FetchLike, over: Partial<Parameters<typeof createHoverClient>[0]> = {}) =>
  createHoverClient({ getAccessToken: async () => TOKEN, fetch: f, ...over });

// ---------- client ----------
test("list jobs: URL, bearer token, search text, page size, and jobs normalised", async () => {
  const { f, calls } = fake(() => json({ results: [hoverJob, { id: 2, address: {}, models: [{ id: 5 }, {}] }], pagination: { current_page: 1, next_page: null } }));
  const jobs = await client(f).listJobs("100 Example Rd", 25);
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, "https://hover.to/api/v3/jobs");
  assert.deepEqual([u.searchParams.get("search"), u.searchParams.get("per")], ["100 Example Rd", "25"]);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(jobs[0], {
    id: "17344154", name: "Miller roof", state: "completed", externalId: null,
    address: { street: "100 Example Rd", city: "West Plains", state: "MO", postalCode: "65775" },
    models: [{ id: "17338410", state: "complete" }, { id: "17338999", state: "uploading" }],
  });
  assert.deepEqual([jobs[1].id, jobs[1].state, jobs[1].models], ["2", "unknown", [{ id: "5", state: "unknown" }]]);   // a model without an id is dropped
});

test("list jobs: a search under 3 characters makes no request; page size is clamped to 1 to 100", async () => {
  const { f, calls } = fake(() => json({ results: [] }));
  const c = client(f);
  assert.deepEqual(await c.listJobs("ab"), []);
  assert.deepEqual(await c.listJobs("   "), []);
  assert.equal(calls.length, 0);
  await c.listJobs("abc", 5000);
  await c.listJobs("abc", 0);
  assert.deepEqual(calls.map((x) => new URL(x.url).searchParams.get("per")), ["100", "1"]);
  assert.deepEqual(await createHoverClient({ getAccessToken: async () => TOKEN, fetch: fake(() => json({})).f }).listJobs("abc"), []);   // no results key
});

test("measurements: the documented path, full_json, and an encoded model id", async () => {
  const { f, calls } = fake(() => json({ roof: {} }));
  await client(f).getMeasurements("17338410");
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/api/v3/models/17338410/artifacts/measurements.json");
  assert.equal(u.searchParams.get("version"), "full_json");
  await client(f).getMeasurements("../x?y=1");
  assert.ok(!calls[1].url.includes("../") && calls[1].url.includes("%2F"));
});

test("a 401 retries once with a fresh token; a second 401 is an auth error", async () => {
  const asked: boolean[] = [];
  let n = 0;
  const { f } = fake(() => (++n === 1 ? json({}, 401) : json({ results: [] })));
  await client(f, { getAccessToken: async (force) => { asked.push(force); return TOKEN; } }).listJobs("abc");
  assert.deepEqual(asked, [false, true]);
  const { f: always401 } = fake(() => json({}, 401));
  await assert.rejects(() => client(always401).listJobs("abc"), (e: HoverError) => e.kind === "auth");
});

test("errors: each HTTP status maps to a kind; rate limits carry Retry-After", async () => {
  for (const [status, kind] of [[403, "auth"], [404, "not_found"], [400, "bad_request"], [422, "bad_request"], [429, "rate_limited"], [500, "server"], [503, "server"]] as const) {
    const { f } = fake(() => json({ error: "x" }, status, status === 429 ? { "retry-after": "30" } : {}));
    await assert.rejects(() => client(f).getMeasurements("1"), (e: HoverError) => e.kind === kind && (status !== 429 || e.retryAfterSeconds === 30), String(status));
  }
});

test("errors: network failure, timeout, not JSON, and the token provider failing", async () => {
  await assert.rejects(() => client(async () => { throw new Error("ECONNRESET"); }).listJobs("abc"), (e: HoverError) => e.kind === "network");
  const slow: FetchLike = (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
  await assert.rejects(() => client(slow, { timeoutMs: 20 }).listJobs("abc"), (e: HoverError) => e.kind === "network");
  await assert.rejects(() => client(fake(() => new Response("<html>", { status: 200 })).f).listJobs("abc"), (e: HoverError) => e.kind === "server");
  await assert.rejects(() => client(fake(() => json({ results: [{ name: "no id" }] })).f).listJobs("abc"), (e: HoverError) => e.kind === "server");
  const notConnected = client(fake(() => json({})).f, { getAccessToken: async () => { throw new HoverError("auth", "Hover isn't connected"); } });
  await assert.rejects(() => notConnected.listJobs("abc"), (e: HoverError) => e.kind === "auth");
});

test("the log has the endpoint only: no token, no search text, no model id", async () => {
  const events: unknown[] = [];
  const log = async (e: unknown) => { events.push(e); };
  const c = client(fake(() => json({ results: [], roof: {} })).f, { log });
  await c.listJobs("31 Secret Address Ln");
  await c.getMeasurements("98765432");
  await client(fake(() => json({}, 500)).f, { log }).getMeasurements("98765432").catch(() => undefined);
  const logged = JSON.stringify(events);
  assert.ok(logged.includes("GET /api/v3/jobs") && logged.includes("/models/:id/artifacts/measurements.json"));
  assert.ok(!logged.includes(TOKEN) && !logged.includes("Secret Address") && !logged.includes("98765432"));
  await client(fake(() => json({ results: [] })).f, { log: async () => { throw new Error("log down"); } }).listJobs("abc");   // a failing log never breaks a call
});

test("a custom base URL is used", async () => {
  const { f, calls } = fake(() => json({ results: [] }));
  await client(f, { baseUrl: "http://localhost:9999/" }).listJobs("abc");
  assert.ok(calls[0].url.startsWith("http://localhost:9999/api/v3/jobs?"));
});

// ---------- OAuth ----------
test("oauth: configuration comes from the environment; incomplete means off", () => {
  assert.equal(hoverOAuthFromEnv({}), null);
  assert.equal(hoverOAuthFromEnv({ HOVER_CLIENT_ID: "a", HOVER_CLIENT_SECRET: "b" }), null);
  assert.deepEqual(hoverOAuthFromEnv({ HOVER_CLIENT_ID: " a ", HOVER_CLIENT_SECRET: "b", HOVER_REDIRECT_URI: "http://x/cb" }), { clientId: "a", clientSecret: "b", redirectUri: "http://x/cb", baseUrl: undefined });
});

test("oauth: the authorize link carries the documented parameters and our state, never the secret", () => {
  const u = new URL(hoverAuthorizeUrl(OAUTH, "state-abc"));
  assert.equal(u.origin + u.pathname, "https://hover.to/oauth/authorize");
  assert.deepEqual([u.searchParams.get("response_type"), u.searchParams.get("client_id"), u.searchParams.get("redirect_uri"), u.searchParams.get("state")], ["code", "cid-123", OAUTH.redirectUri, "state-abc"]);
  assert.ok(!u.toString().includes("csecret"));
});

test("oauth: exchanging a code posts JSON to /oauth/token and returns tokens that expire in 2 hours", async () => {
  const { f, calls } = fake(() => json(tokenBody(1)));
  const t = await exchangeHoverCode(OAUTH, "code-xyz", f, T0);
  assert.equal(calls[0].url, "https://hover.to/oauth/token");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    client_id: "cid-123", client_secret: "csecret-456", grant_type: "authorization_code", code: "code-xyz", redirect_uri: OAUTH.redirectUri,
  });
  assert.deepEqual([t.accessToken, t.refreshToken, t.ownerId, t.expiresAt.toISOString()], ["acc1", "ref1", "42", new Date(T0.getTime() + 7_200_000).toISOString()]);
});

test("oauth: refreshing sends the refresh token; bad codes are auth errors; nothing from a failure leaks", async () => {
  const { f, calls } = fake(() => json(tokenBody(2)));
  await refreshHoverTokens(OAUTH, "ref1", f, T0);
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { client_id: "cid-123", client_secret: "csecret-456", grant_type: "refresh_token", refresh_token: "ref1" });
  for (const [status, kind] of [[400, "auth"], [401, "auth"], [422, "bad_request"], [500, "server"]] as const) {
    const err = await exchangeHoverCode(OAUTH, "c", fake(() => json({ error: `bad ${TOKEN} csecret-456` }, status)).f, T0).catch((e: HoverError) => e);
    assert.ok(err instanceof HoverError && err.kind === kind, String(status));
    assert.ok(!err.message.includes("csecret") && !err.message.includes(TOKEN));
  }
  for (const bad of [{}, { access_token: "a" }, tokenBody(1, { expires_in: 0 }), tokenBody(1, { expires_in: "soon" }), tokenBody(1, { refresh_token: "" })]) {
    await assert.rejects(() => exchangeHoverCode(OAUTH, "c", fake(() => json(bad)).f, T0), (e: HoverError) => e.kind === "server");
  }
  await assert.rejects(() => exchangeHoverCode(OAUTH, "c", async () => { throw new Error("down"); }, T0), (e: HoverError) => e.kind === "network");
});

// ---------- token provider ----------
async function connected(expiresInMs = 7_200_000) {
  const store = new MemoryHoverTokenStore();
  await store.connect({ accessToken: "acc0", refreshToken: "ref0", expiresAt: new Date(T0.getTime() + expiresInMs), ownerId: "42" }, "admin");
  return store;
}

test("tokens: a token with plenty of life is used as it is, with no call to Hover", async () => {
  const store = await connected();
  const { f, calls } = fake(() => json(tokenBody(1)));
  const get = createHoverTokenProvider({ store, oauth: OAUTH, fetch: f, now: () => T0 });
  assert.equal(await get(false), "acc0");
  assert.equal(calls.length, 0);
});

test("tokens: near expiry it refreshes, saves the NEW refresh token, and uses it next time", async () => {
  const store = await connected(60_000);               // one minute left: inside the safety margin
  let n = 0;
  const { f, calls } = fake(() => json(tokenBody(++n)));
  const get = createHoverTokenProvider({ store, oauth: OAUTH, fetch: f, now: () => T0 });
  assert.equal(await get(false), "acc1");
  assert.equal(JSON.parse(calls[0].init.body as string).refresh_token, "ref0");
  assert.equal((await store.get())!.refreshToken, "ref1");                          // rotated and saved
  assert.equal(await get(false), "acc1");
  assert.equal(calls.length, 1);
  await get(true);                                                                  // asked to refresh: uses ref1, not ref0 again
  assert.equal(JSON.parse(calls[1].init.body as string).refresh_token, "ref1");
});

test("tokens: many requests at once cause exactly one refresh, and all get the new token", async () => {
  const store = await connected(10_000);
  let n = 0;
  const { f, calls } = fake(async () => { await new Promise((r) => setTimeout(r, 15)); return json(tokenBody(++n)); });
  const get = createHoverTokenProvider({ store, oauth: OAUTH, fetch: f, now: () => T0 });
  const got = await Promise.all(Array.from({ length: 8 }, () => get(false)));
  assert.equal(calls.length, 1);
  assert.deepEqual([...new Set(got)], ["acc1"]);
});

test("tokens: after a 401 two callers asking for a fresh token still refresh only once", async () => {
  const store = await connected();
  let n = 0;
  const { f, calls } = fake(async () => { await new Promise((r) => setTimeout(r, 15)); return json(tokenBody(++n)); });
  const get = createHoverTokenProvider({ store, oauth: OAUTH, fetch: f, now: () => T0 });
  const got = await Promise.all([get(true), get(true), get(true)]);
  assert.equal(calls.length, 1);
  assert.deepEqual([...new Set(got)], ["acc1"]);
});

test("tokens: a refused refresh token marks Hover as needing a reconnect, and later calls fail fast", async () => {
  const store = await connected(10_000);
  const { f, calls } = fake(() => json({ error: "invalid_grant" }, 400));
  const get = createHoverTokenProvider({ store, oauth: OAUTH, fetch: f, now: () => T0 });
  await assert.rejects(() => get(false), (e: HoverError) => e.kind === "auth");
  assert.equal((await store.get())!.status, "needs_reconnect");
  await assert.rejects(() => get(false), (e: HoverError) => e.kind === "auth" && /connected again/.test(e.message));
  assert.equal(calls.length, 1);                              // the spent token is not tried again
  await store.connect({ accessToken: "new", refreshToken: "newref", expiresAt: new Date(T0.getTime() + 7_200_000), ownerId: null }, "admin");   // a person reconnects
  assert.equal(await get(false), "new");
});

test("tokens: a network blip does not disconnect Hover, and an unconnected CRM says so", async () => {
  const store = await connected(10_000);
  const get = createHoverTokenProvider({ store, oauth: OAUTH, fetch: async () => { throw new Error("down"); }, now: () => T0 });
  await assert.rejects(() => get(false), (e: HoverError) => e.kind === "network");
  assert.equal((await store.get())!.status, "connected");
  const empty = createHoverTokenProvider({ store: new MemoryHoverTokenStore(), oauth: OAUTH, fetch: fake(() => json({})).f, now: () => T0 });
  await assert.rejects(() => empty(false), (e: HoverError) => e.kind === "auth" && /isn't connected/.test(e.message));
});

test("tokens: the 'needs reconnect' flag survives (a throw inside the lock would be rolled back like a database transaction)", async () => {
  const store = await connected(10_000);
  const get = createHoverTokenProvider({ store, oauth: OAUTH, fetch: fake(() => json({ error: "invalid_grant" }, 401)).f, now: () => T0 });
  await assert.rejects(() => get(false), (e: HoverError) => e.kind === "auth");
  assert.equal((await store.get())!.status, "needs_reconnect");
  // a failure that is NOT a refused token (a crash) leaves everything as it was
  const store2 = await connected(10_000);
  const crashing = createHoverTokenProvider({ store: store2, oauth: OAUTH, fetch: async () => { throw new Error("boom"); }, now: () => T0 });
  await assert.rejects(() => crashing(false));
  assert.deepEqual([(await store2.get())!.status, (await store2.get())!.refreshToken], ["connected", "ref0"]);
});