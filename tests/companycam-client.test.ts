import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CompanyCamError, companyCamConfigFromEnv, createCompanyCamClient, type FetchLike,
} from "../src/integrations/companycam/client.ts";

const TOKEN = "cc-secret-token-123";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function fake(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: FetchLike = async (url, init = {}) => { calls.push({ url, init }); return responder(url, init); };
  return { f, calls };
}
const projectJson = {
  id: "1001", name: "Miller, Dana - Job 1", project_url: "https://app.companycam.com/projects/1001", status: "active",
  address: { street_address_1: "100 Example Rd", city: "West Plains", state: "MO", postal_code: "65775" },
};

test("create project: URL, bearer token, JSON body and address mapping", async () => {
  const { f, calls } = fake(() => json(projectJson, 201));
  const c = createCompanyCamClient({ token: TOKEN, fetch: f });
  const p = await c.createProject({ name: "Miller, Dana - Job 1", address: { street: "100 Example Rd", city: "West Plains", state: "MO", postalCode: "65775" }, contactName: "Dana Miller" });
  assert.deepEqual(p, {
    id: "1001", name: "Miller, Dana - Job 1", projectUrl: "https://app.companycam.com/projects/1001", status: "active",
    address: { street: "100 Example Rd", city: "West Plains", state: "MO", postalCode: "65775" },
  });
  const { url, init } = calls[0];
  assert.equal(url, "https://api.companycam.com/v2/projects");
  assert.equal(init.method, "POST");
  const h = init.headers as Record<string, string>;
  assert.equal(h.Authorization, `Bearer ${TOKEN}`);
  assert.equal(h["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body as string), {
    name: "Miller, Dana - Job 1",
    address: { street_address_1: "100 Example Rd", city: "West Plains", state: "MO", postal_code: "65775", country: "US" },
    primary_contact: { name: "Dana Miller" },
  });
});

test("create project: the creator header is sent only when configured; no contact when none given", async () => {
  const withUser = fake(() => json(projectJson, 201));
  await createCompanyCamClient({ token: TOKEN, userEmail: "al@example.com", fetch: withUser.f })
    .createProject({ name: "n", address: { street: "s", city: "c", state: "MO", postalCode: "65775" } });
  assert.equal((withUser.calls[0].init.headers as Record<string, string>)["X-CompanyCam-User"], "al@example.com");
  assert.equal("primary_contact" in JSON.parse(withUser.calls[0].init.body as string), false);
  const without = fake(() => json(projectJson, 201));
  await createCompanyCamClient({ token: TOKEN, fetch: without.f }).createProject({ name: "n", address: { street: "s", city: "c", state: "MO", postalCode: "65775" } });
  assert.equal("X-CompanyCam-User" in (without.calls[0].init.headers as Record<string, string>), false);
});

test("search: query, active only, page size; results normalised", async () => {
  const { f, calls } = fake(() => json([projectJson, { id: 2002, name: null, address: {} }]));
  const r = await createCompanyCamClient({ token: TOKEN, fetch: f }).searchProjects("100 Example Rd");
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/v2/projects");
  assert.deepEqual([u.searchParams.get("query"), u.searchParams.get("status"), u.searchParams.get("per_page")], ["100 Example Rd", "active", "25"]);
  assert.equal(calls[0].init.method, "GET");
  assert.equal("Content-Type" in (calls[0].init.headers as Record<string, string>), false);
  assert.deepEqual(r.map((p) => [p.id, p.name, p.status]), [["1001", "Miller, Dana - Job 1", "active"], ["2002", null, "active"]]);
  assert.equal(r[1].address.street, null);
});

test("get project and list photos: thumbnails only, web as the fallback, never the original", async () => {
  const { f, calls } = fake((url) => url.includes("/photos")
    ? json([
        { id: "p1", captured_at: 1_760_000_000, creator_name: "Crew One", uris: [{ type: "original", uri: "https://img/o1" }, { type: "web", uri: "https://img/w1" }, { type: "thumbnail", uri: "https://img/t1" }] },
        { id: "p2", captured_at: "2026-10-01T12:00:00Z", uris: [{ type: "original", uri: "https://img/o2" }, { type: "web", url: "https://img/w2" }] },
        { id: "p3", uris: [{ type: "original", uri: "https://img/o3" }] },
        { id: "p4" },
      ])
    : json(projectJson));
  const c = createCompanyCamClient({ token: TOKEN, fetch: f });
  assert.equal((await c.getProject("1001")).id, "1001");
  assert.equal(calls[0].url, "https://api.companycam.com/v2/projects/1001");
  const photos = await c.listPhotos("1001", 50);
  assert.equal(new URL(calls[1].url).searchParams.get("per_page"), "50");
  assert.deepEqual(photos.map((p) => p.thumbnailUrl), ["https://img/t1", "https://img/w2", null, null]);
  assert.equal(photos[0].capturedAt, new Date(1_760_000_000 * 1000).toISOString());
  assert.equal(photos[0].creatorName, "Crew One");
  assert.ok(!JSON.stringify(photos).includes("o1") && !JSON.stringify(photos).includes("o2"));   // originals never leave the integration
});

test("project ids with odd characters are encoded into the path", async () => {
  const { f, calls } = fake(() => json(projectJson));
  await createCompanyCamClient({ token: TOKEN, fetch: f }).getProject("../admin?x=1");
  assert.ok(!calls[0].url.includes("../") && calls[0].url.includes("%2F"));
});

test("errors: each HTTP status maps to a kind; rate limits carry Retry-After", async () => {
  const kinds: [number, string][] = [[401, "auth"], [403, "auth"], [404, "not_found"], [400, "bad_request"], [422, "bad_request"], [429, "rate_limited"], [500, "server"], [503, "server"]];
  for (const [status, kind] of kinds) {
    const { f } = fake(() => json({ error: "x" }, status, status === 429 ? { "retry-after": "42" } : {}));
    await assert.rejects(() => createCompanyCamClient({ token: TOKEN, fetch: f }).getProject("1"),
      (e: CompanyCamError) => e instanceof CompanyCamError && e.kind === kind && (status !== 429 || e.retryAfterSeconds === 42), String(status));
  }
  const { f } = fake(() => json({}, 429));
  await assert.rejects(() => createCompanyCamClient({ token: TOKEN, fetch: f }).getProject("1"), (e: CompanyCamError) => e.retryAfterSeconds === null);
});

test("errors: network failures, timeouts and malformed responses", async () => {
  await assert.rejects(() => createCompanyCamClient({ token: TOKEN, fetch: async () => { throw new Error("ECONNRESET"); } }).getProject("1"),
    (e: CompanyCamError) => e.kind === "network");
  const slow: FetchLike = (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
  await assert.rejects(() => createCompanyCamClient({ token: TOKEN, fetch: slow, timeoutMs: 20 }).getProject("1"), (e: CompanyCamError) => e.kind === "network");
  const { f: notJson } = fake(() => new Response("<html>oops</html>", { status: 200 }));
  await assert.rejects(() => createCompanyCamClient({ token: TOKEN, fetch: notJson }).getProject("1"), (e: CompanyCamError) => e.kind === "server");
  const { f: noId } = fake(() => json({ name: "no id" }));
  await assert.rejects(() => createCompanyCamClient({ token: TOKEN, fetch: noId }).getProject("1"), (e: CompanyCamError) => e.kind === "server");
});

test("the access token never appears in errors or in the log, and neither does the search text", async () => {
  const events: unknown[] = [];
  const log = async (e: unknown) => { events.push(e); };
  const bad = fake(() => json({ error: `invalid token ${TOKEN}` }, 401));
  const ok = fake(() => json([]));
  const client = (f: FetchLike) => createCompanyCamClient({ token: TOKEN, fetch: f, log });
  const err = await client(bad.f).searchProjects("31 Secret Address Ln").catch((e: Error) => e);
  assert.ok(err instanceof CompanyCamError);
  assert.ok(!(err as Error).message.includes(TOKEN));
  await client(ok.f).searchProjects("31 Secret Address Ln");
  await client(ok.f).listPhotos("1234567");
  const logged = JSON.stringify(events);
  assert.ok(!logged.includes(TOKEN));
  assert.ok(!logged.includes("Secret Address"));
  assert.ok(logged.includes("GET /projects"));
  assert.ok(logged.includes("/projects/:id/photos"));          // ids are masked in the log
  assert.ok(!logged.includes("1234567"));
});

test("a failing log never breaks a request", async () => {
  const { f } = fake(() => json(projectJson));
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
  assert.deepEqual(companyCamConfigFromEnv({ COMPANYCAM_ACCESS_TOKEN: " t ", COMPANYCAM_USER_EMAIL: " a@b.com " }), { token: "t", userEmail: "a@b.com", baseUrl: undefined });
  assert.equal(companyCamConfigFromEnv({ COMPANYCAM_ACCESS_TOKEN: "t", COMPANYCAM_API_BASE: "http://localhost:9999/v2/" })?.baseUrl, "http://localhost:9999/v2/");
});

test("a custom base URL is used (with or without a trailing slash)", async () => {
  const { f, calls } = fake(() => json([]));
  await createCompanyCamClient({ token: TOKEN, baseUrl: "http://localhost:9999/v2/", fetch: f }).searchProjects("x");
  assert.ok(calls[0].url.startsWith("http://localhost:9999/v2/projects?"));
});
