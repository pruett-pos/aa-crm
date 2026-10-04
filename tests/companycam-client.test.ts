import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CompanyCamError, companyCamConfigFromEnv, createCompanyCamClient, type FetchLike,
} from "../src/integrations/companycam/client.ts";

const TOKEN = "cc-secret-token-123";
const BASE = "https://app.companycam.com/public_api/v1";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
/** The current API wraps everything in { data, errors, meta }. */
const env = (data: unknown, meta: unknown = {}, errors: unknown[] = []) => ({ data, errors, meta });

function fake(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: FetchLike = async (url, init = {}) => { calls.push({ url, init }); return responder(url, init); };
  return { f, calls };
}
const projectJson = {
  id: "1001", name: "Miller, Dana - Job 1", project_url: "https://app.companycam.com/projects/1001", status: "active", archived: false,
  address: { street_address_1: "100 Example Rd", street_address_2: null, city: "West Plains", state: "MO", postal_code: "65775", country: "US" },
};

test("create project: URL, bearer token, nested project body and address mapping", async () => {
  const { f, calls } = fake(() => json(env(projectJson), 201));
  const c = createCompanyCamClient({ token: TOKEN, fetch: f });
  const p = await c.createProject({ name: "Miller, Dana - Job 1", address: { street: "100 Example Rd", city: "West Plains", state: "MO", postalCode: "65775" }, contactName: "Dana Miller" });
  assert.deepEqual(p, {
    id: "1001", name: "Miller, Dana - Job 1", projectUrl: "https://app.companycam.com/projects/1001", status: "active",
    address: { street: "100 Example Rd", city: "West Plains", state: "MO", postalCode: "65775" },
  });
  const { url, init } = calls[0];
  assert.equal(url, `${BASE}/projects`);
  assert.equal(init.method, "POST");
  const h = init.headers as Record<string, string>;
  assert.equal(h.Authorization, `Bearer ${TOKEN}`);
  assert.equal(h["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body as string), {
    project: {
      name: "Miller, Dana - Job 1", street_address_1: "100 Example Rd", city: "West Plains", state: "MO", postal_code: "65775", country: "US",
      primary_contact: { name: "Dana Miller" },
    },
  });
});

test("create project: no contact when none is given, and nothing but name, address and contact name ever goes out", async () => {
  const { f, calls } = fake(() => json(env(projectJson), 201));
  await createCompanyCamClient({ token: TOKEN, fetch: f }).createProject({ name: "n", address: { street: "s", city: "c", state: "MO", postalCode: "65775" } });
  const sent = JSON.parse(calls[0].init.body as string);
  assert.equal("primary_contact" in sent.project, false);
  assert.deepEqual(Object.keys(sent), ["project"]);
  assert.deepEqual(Object.keys(sent.project).sort(), ["city", "country", "name", "postal_code", "state", "street_address_1"]);
  assert.equal("X-CompanyCam-User" in (calls[0].init.headers as Record<string, string>), false);
});

test("search: uses /projects/search with the query; results normalised; archived and deleted are flagged", async () => {
  const { f, calls } = fake(() => json(env([
    projectJson,
    { id: 2002, name: null, address: {} },
    { ...projectJson, id: "3003", archived: true },
    { ...projectJson, id: "4004", status: "Deleted" },
  ])));
  const r = await createCompanyCamClient({ token: TOKEN, fetch: f }).searchProjects("example");
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/public_api/v1/projects/search");
  assert.equal(u.searchParams.get("query"), "example");
  assert.equal(calls[0].init.method, "GET");
  assert.equal("Content-Type" in (calls[0].init.headers as Record<string, string>), false);
  assert.deepEqual(r.map((p) => [p.id, p.name, p.status]), [["1001", "Miller, Dana - Job 1", "active"], ["2002", null, "active"], ["3003", "Miller, Dana - Job 1", "archived"], ["4004", "Miller, Dana - Job 1", "deleted"]]);
  assert.equal(r[1].address.street, null);
});

test("get project and list photos: thumbnails only, web as the fallback, never the original; has_next drives hasMore", async () => {
  const { f, calls } = fake((url) => url.includes("/photos")
    ? json(env([
        { id: "p1", captured_at: "2026-10-01T12:00:00Z", creator_name: "Crew One", uris: [{ type: "original", uri: "https://img/o1", url: "https://img/o1" }, { type: "web", uri: "https://img/w1" }, { type: "thumbnail", uri: "https://img/t1" }] },
        { id: "p2", captured_at: 1_760_000_000, uris: [{ type: "original", uri: "https://img/o2" }, { type: "web", url: "https://img/w2" }] },
        { id: "p3", uris: [{ type: "original", uri: "https://img/o3" }] },
        { id: "p4" },
      ], { next_cursor: "abc", prev_cursor: null, has_next: true, has_prev: false }))
    : json(env(projectJson)));
  const c = createCompanyCamClient({ token: TOKEN, fetch: f });
  assert.equal((await c.getProject("1001")).id, "1001");
  assert.equal(calls[0].url, `${BASE}/projects/1001`);
  const { photos, hasMore } = await c.listPhotos("1001", 50);
  const u = new URL(calls[1].url);
  assert.equal(u.pathname, "/public_api/v1/projects/1001/photos");
  assert.equal(u.searchParams.get("limit"), "50");
  assert.equal(u.searchParams.has("per_page"), false);
  assert.equal(hasMore, true);
  assert.deepEqual(photos.map((p) => p.thumbnailUrl), ["https://img/t1", "https://img/w2", null, null]);
  assert.equal(photos[0].capturedAt, "2026-10-01T12:00:00Z");
  assert.equal(photos[1].capturedAt, new Date(1_760_000_000 * 1000).toISOString());
  assert.equal(photos[0].creatorName, "Crew One");
  assert.ok(!JSON.stringify(photos).includes("o1") && !JSON.stringify(photos).includes("o2"));   // originals never leave the integration
});

test("list photos: the page size is clamped to CompanyCam's 1 to 100; no more pages means hasMore is false", async () => {
  const { f, calls } = fake(() => json(env([], { has_next: false })));
  const c = createCompanyCamClient({ token: TOKEN, fetch: f });
  assert.deepEqual(await c.listPhotos("1", 5000), { photos: [], hasMore: false });
  await c.listPhotos("1", 0);
  assert.equal(new URL(calls[0].url).searchParams.get("limit"), "100");
  assert.equal(new URL(calls[1].url).searchParams.get("limit"), "1");
  const noMeta = fake(() => json({ data: [], errors: [] }));
  assert.equal((await createCompanyCamClient({ token: TOKEN, fetch: noMeta.f }).listPhotos("1")).hasMore, false);
});

test("project ids with odd characters are encoded into the path", async () => {
  const { f, calls } = fake(() => json(env(projectJson)));
  await createCompanyCamClient({ token: TOKEN, fetch: f }).getProject("../admin?x=1");
  assert.ok(!calls[0].url.includes("../") && calls[0].url.includes("%2F"));
});

test("errors: each HTTP status maps to a kind; rate limits carry Retry-After", async () => {
  const kinds: [number, string][] = [[401, "auth"], [403, "auth"], [404, "not_found"], [400, "bad_request"], [422, "bad_request"], [429, "rate_limited"], [500, "server"], [503, "server"]];
  for (const [status, kind] of kinds) {
    const { f } = fake(() => json({ data: {}, errors: [{ code: "x" }], meta: {} }, status, status === 429 ? { "retry-after": "42" } : {}));
    await assert.rejects(() => createCompanyCamClient({ token: TOKEN, fetch: f }).getProject("1"),
      (e: CompanyCamError) => e instanceof CompanyCamError && e.kind === kind && (status !== 429 || e.retryAfterSeconds === 42), String(status));
  }
  const { f } = fake(() => json({}, 429));
  await assert.rejects(() => createCompanyCamClient({ token: TOKEN, fetch: f }).getProject("1"), (e: CompanyCamError) => e.retryAfterSeconds === null);
});

test("errors: expired, revoked and invalid tokens are all auth errors (401), as is a missing scope (403)", async () => {
  for (const [status, code] of [[401, "invalid_token"], [401, "token_expired"], [401, "token_revoked"], [403, "insufficient_scope"]] as const) {
    const { f } = fake(() => json({ data: {}, errors: [{ code }], meta: {} }, status, { "www-authenticate": `Bearer error="${code}"` }));
    await assert.rejects(() => createCompanyCamClient({ token: TOKEN, fetch: f }).searchProjects("x"), (e: CompanyCamError) => e.kind === "auth", code);
  }
});

test("errors: network failures, timeouts, malformed responses, and a 200 with errors or no data", async () => {
  await assert.rejects(() => createCompanyCamClient({ token: TOKEN, fetch: async () => { throw new Error("ECONNRESET"); } }).getProject("1"),
    (e: CompanyCamError) => e.kind === "network");
  const slow: FetchLike = (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
  await assert.rejects(() => createCompanyCamClient({ token: TOKEN, fetch: slow, timeoutMs: 20 }).getProject("1"), (e: CompanyCamError) => e.kind === "network");
  const server = (r: () => Response) => (c: ReturnType<typeof createCompanyCamClient>) => assert.rejects(() => c.getProject("1"), (e: CompanyCamError) => e.kind === "server");
  for (const make of [
    () => new Response("<html>oops</html>", { status: 200 }),
    () => json({ name: "bare object, no envelope" }),                       // the legacy shape is not accepted
    () => json(env({ name: "no id" })),
    () => json({ data: projectJson, errors: [{ code: "partial_failure" }], meta: {} }),
    () => json({ data: null, errors: [], meta: {} }),
    () => json(null),
  ]) await server(make)(createCompanyCamClient({ token: TOKEN, fetch: fake(make).f }));
});

test("the access token never appears in errors or in the log, and neither does the search text", async () => {
  const events: unknown[] = [];
  const log = async (e: unknown) => { events.push(e); };
  const bad = fake(() => json({ data: {}, errors: [{ message: `invalid token ${TOKEN}` }], meta: {} }, 401));
  const ok = fake(() => json(env([], { has_next: false })));
  const client = (f: FetchLike) => createCompanyCamClient({ token: TOKEN, fetch: f, log });
  const err = await client(bad.f).searchProjects("31 Secret Address Ln").catch((e: Error) => e);
  assert.ok(err instanceof CompanyCamError);
  assert.ok(!(err as Error).message.includes(TOKEN));
  await client(ok.f).searchProjects("31 Secret Address Ln");
  await client(ok.f).listPhotos("1234567");
  await client(fake(() => json(env(projectJson))).f).getProject("7654321");
  const logged = JSON.stringify(events);
  assert.ok(!logged.includes(TOKEN));
  assert.ok(!logged.includes("Secret Address"));
  assert.ok(logged.includes("GET /projects/search"));            // the search endpoint is not mistaken for a project id
  assert.ok(logged.includes("GET /projects/:id/photos"));        // ids are masked in the log
  assert.ok(logged.includes("GET /projects/:id\""));
  assert.ok(!logged.includes("1234567") && !logged.includes("7654321"));
});

test("a failing log never breaks a request", async () => {
  const { f } = fake(() => json(env(projectJson)));
  const c = createCompanyCamClient({ token: TOKEN, fetch: f, log: async () => { throw new Error("log down"); } });
  assert.equal((await c.getProject("1")).id, "1001");          // the call still succeeds
  const bad = fake(() => json({}, 404));
  await assert.rejects(
    () => createCompanyCamClient({ token: TOKEN, fetch: bad.f, log: async () => { throw new Error("log down"); } }).getProject("1"),
    (e: CompanyCamError) => e.kind === "not_found",         // and errors keep their real kind, not the logger's
  );
});

test("config comes from the environment; no token means the feature is off; the base can be overridden", () => {
  assert.equal(companyCamConfigFromEnv({}), null);
  assert.equal(companyCamConfigFromEnv({ COMPANYCAM_ACCESS_TOKEN: "   " }), null);
  assert.deepEqual(companyCamConfigFromEnv({ COMPANYCAM_ACCESS_TOKEN: " t " }), { token: "t", baseUrl: undefined });
  assert.equal(companyCamConfigFromEnv({ COMPANYCAM_ACCESS_TOKEN: "t", COMPANYCAM_API_BASE: "http://localhost:9999/public_api/v1/" })?.baseUrl, "http://localhost:9999/public_api/v1/");
});

test("a custom base URL is used (with or without a trailing slash)", async () => {
  const { f, calls } = fake(() => json(env([])));
  await createCompanyCamClient({ token: TOKEN, baseUrl: "http://localhost:9999/public_api/v1/", fetch: f }).searchProjects("x");
  assert.ok(calls[0].url.startsWith("http://localhost:9999/public_api/v1/projects/search?"));
});
