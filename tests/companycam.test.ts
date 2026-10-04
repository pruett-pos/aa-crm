import { test } from "node:test";
import assert from "node:assert/strict";
import { createCompanyCamClient, type FetchLike } from "../src/integrations/companycam/client.ts";
import { normalizeStreet, sameAddress } from "../src/lib/companycam/address.ts";
import {
  MAX_ATTEMPTS, ManageError, backoffMinutes, canManageProject, canSeePhotos, canUnlinkProject, clearPhotoCache, ensureProject,
  linkProject, photosFor, projectName, searchForLink, unlinkProject,
} from "../src/lib/companycam/logic.ts";
import { MemoryCompanyCamStore } from "../src/lib/companycam/memory-store.ts";
import type { Actor, ProductionJob, TradeRow } from "../src/lib/production/types.ts";

// ---------- a fake CompanyCam server (current public API shapes) with real state ----------
type Fp = { id: string; name: string | null; project_url: string; status: string; archived: boolean; address: { street_address_1: string; city: string; state: string; postal_code: string } };
function server() {
  const projects: Fp[] = [];
  const photos = new Map<string, unknown[]>();
  const requests: { method: string; path: string; query: string; body?: unknown }[] = [];
  let nextId = 5000;
  let failures: { status: number; headers?: Record<string, string> }[] = [];
  let networkDown = false;
  const j = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
  const ok = (data: unknown, status = 200, meta: unknown = {}) => j({ data, errors: [], meta }, status);
  const f: FetchLike = async (url, init = {}) => {
    if (networkDown) throw new Error("ECONNREFUSED");
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const path = u.pathname.replace("/public_api/v1", "");
    requests.push({ method, path, query: u.search, body });
    const fail = failures.shift();
    if (fail) return j({ data: {}, errors: [{ code: "boom" }], meta: {} }, fail.status, fail.headers);
    if (method === "POST" && path === "/projects") {
      const b = body.project;
      const p: Fp = {
        id: String(nextId++), name: b.name, project_url: `https://app.companycam.com/projects/${nextId - 1}`, status: "active", archived: false,
        address: { street_address_1: b.street_address_1, city: b.city, state: b.state, postal_code: b.postal_code },
      };
      projects.push(p);
      return ok(p, 201);
    }
    if (method === "GET" && path === "/projects/search") {
      const q = (u.searchParams.get("query") ?? "").toLowerCase();
      // like the real one, this includes archived projects
      return ok(projects.filter((p) => (p.name ?? "").toLowerCase().includes(q) || p.address.street_address_1.toLowerCase().includes(q)));
    }
    const photoMatch = path.match(/^\/projects\/([^/]+)\/photos$/);
    if (photoMatch) {
      const all = photos.get(decodeURIComponent(photoMatch[1])) ?? [];
      const limit = Number(u.searchParams.get("limit") ?? 50);
      return ok(all.slice(0, limit), 200, { has_next: all.length > limit, next_cursor: all.length > limit ? "next" : null });
    }
    const one = path.match(/^\/projects\/([^/]+)$/);
    if (one) { const p = projects.find((x) => x.id === decodeURIComponent(one[1])); return p ? ok(p) : j({ data: {}, errors: [{ code: "not_found" }], meta: {} }, 404); }
    return j({}, 404);
  };
  return {
    f, projects, photos, requests,
    failNext: (status: number, headers?: Record<string, string>) => { failures.push({ status, headers }); },
    down: (v: boolean) => { networkDown = v; },
    count: (method: string, path: string) => requests.filter((r) => r.method === method && r.path === path).length,
    addProject: (street: string, zip: string, over: Partial<Fp> = {}): Fp => {
      const p: Fp = { id: String(nextId++), name: "Existing", project_url: `https://app.companycam.com/projects/${nextId - 1}`, status: "active", archived: false, address: { street_address_1: street, city: "West Plains", state: "MO", postal_code: zip }, ...over };
      projects.push(p);
      return p;
    },
  };
}
const setup = () => {
  const srv = server();
  const client = createCompanyCamClient({ token: "tok", fetch: srv.f });
  const store = new MemoryCompanyCamStore();
  return { srv, client, store };
};
const T0 = new Date("2026-10-14T17:00:00Z");
const at = (ms: number) => () => new Date(T0.getTime() + ms);

// ---------- names and addresses ----------
test("project name: last, first - job - trades; cleaned and capped", () => {
  assert.equal(projectName({ firstName: "Dana", lastName: "Miller", jobNumber: 24, divisions: ["roofing", "siding"] }), "Miller, Dana - Job 24 - Roofing + Siding");
  assert.equal(projectName({ firstName: "Pat", lastName: "Lee", jobNumber: 5, divisions: ["windows_doors"] }), "Lee, Pat - Job 5 - Windows and doors");
  assert.equal(projectName({ firstName: "Evil\n\t", lastName: "  Spaced   Out ", jobNumber: 1, divisions: ["roofing"] }), "Spaced Out, Evil - Job 1 - Roofing");
  assert.equal(projectName({ firstName: "x".repeat(200), lastName: "y", jobNumber: 1, divisions: ["roofing"] }).length, 120);
});

test("addresses: abbreviations and punctuation are ignored; zip decides; a missing zip never matches", () => {
  assert.equal(normalizeStreet("100 N. Example Rd."), normalizeStreet("100 north EXAMPLE road"));
  assert.notEqual(normalizeStreet("100 Example Rd"), normalizeStreet("101 Example Rd"));
  const job = { street: "100 Example Rd", zip: "65775" };
  assert.ok(sameAddress({ street: "100 example road", postalCode: "65775-1234" }, job));
  assert.ok(!sameAddress({ street: "100 Example Rd", postalCode: "65801" }, job));
  assert.ok(!sameAddress({ street: "100 Example Rd", postalCode: null }, job));
  assert.ok(!sameAddress({ street: null, postalCode: "65775" }, job));
  assert.ok(!sameAddress({ street: "100 Example Ln", postalCode: "65775" }, job));
});

test("backoff: grows with each failure, auth waits a day, rate limits honor Retry-After", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((n) => backoffMinutes(n, "server", null)), [1, 5, 15, 60, 360, 1440, 1440]);
  assert.equal(backoffMinutes(1, "auth", null), 1440);
  assert.equal(backoffMinutes(1, "rate_limited", 7200), 120);
  assert.equal(backoffMinutes(5, "rate_limited", 60), 360);          // never shorter than the normal backoff
  assert.equal(backoffMinutes(0, "network", null), 1);
});

// ---------- creating and linking ----------
test("a new job gets a project: created with the name, address and contact, then recorded", async () => {
  const { srv, client, store } = setup();
  const job = store.add({ jobNumber: 24, divisions: ["roofing", "siding"] });
  const r = await ensureProject(store, client, job.id, { now: at(0) });
  assert.equal(r.status, "linked");
  assert.deepEqual(srv.requests.map((x) => `${x.method} ${x.path}`), ["GET /projects/search", "POST /projects"]);
  assert.equal(new URLSearchParams(srv.requests[0].query).get("query"), "example");      // the street-name word, so spelling variants are found
  const sent = srv.requests[1].body as { project: Record<string, unknown> };
  const created = sent.project;
  assert.equal(created.name, "Miller, Dana - Job 24 - Roofing + Siding");
  assert.deepEqual({ ...created, name: undefined, primary_contact: undefined }, {
    street_address_1: "100 Example Rd", city: "West Plains", state: "MO", postal_code: "65775", country: "US", name: undefined, primary_contact: undefined,
  });
  assert.deepEqual(created.primary_contact, { name: "Dana Miller" });
  const saved = store.jobs[0];
  assert.deepEqual([saved.status, saved.linkMethod, saved.attempts, saved.error], ["linked", "created", 0, null]);
  assert.match(saved.projectUrl ?? "", /app\.companycam\.com\/projects\//);
  // only name and address went out: no phone, email, price or margin
  assert.ok(!/phone|email|price|margin|cents/i.test(JSON.stringify(created)));
});

test("calling it again does nothing: already linked, no requests", async () => {
  const { srv, client, store } = setup();
  const job = store.add();
  await ensureProject(store, client, job.id, { now: at(0) });
  const before = srv.requests.length;
  assert.deepEqual(await ensureProject(store, client, job.id, { now: at(1000) }), { status: "already_linked" });
  assert.equal(srv.requests.length, before);
  assert.equal(srv.projects.length, 1);
});

test("not configured, unknown, waiting-for-review and closed jobs make no requests and change nothing", async () => {
  const { srv, client, store } = setup();
  const job = store.add();
  assert.deepEqual(await ensureProject(store, null, job.id), { status: "not_configured" });
  assert.equal(store.jobs[0].status, "none");
  assert.deepEqual(await ensureProject(store, client, "nope"), { status: "skipped", reason: "not_found" });
  const review = store.add({ needsReview: true });
  assert.deepEqual(await ensureProject(store, client, review.id), { status: "skipped", reason: "waiting_for_review" });
  const lost = store.add({ stage: "lost" });
  assert.deepEqual(await ensureProject(store, client, lost.id), { status: "skipped", reason: "closed" });
  assert.equal(srv.requests.length, 0);
  assert.equal(review.status, "none");
});

test("an existing project at the same address is linked instead of creating a duplicate", async () => {
  const { srv, client, store } = setup();
  const existing = srv.addProject("100 Example Road", "65775");       // someone already made it in CompanyCam (different spelling)
  const job = store.add();
  const r = await ensureProject(store, client, job.id, { now: at(0) });
  assert.deepEqual(r, { status: "linked", method: "auto_match", projectId: existing.id });
  assert.equal(srv.count("POST", "/projects"), 0);
  assert.equal(store.jobs[0].linkMethod, "auto_match");
});

test("archived and deleted projects are never matched, and a new one is created instead", async () => {
  const { srv, client, store } = setup();
  srv.addProject("100 Example Rd", "65775", { archived: true });
  srv.addProject("100 Example Road", "65775", { status: "deleted" });
  const r = await ensureProject(store, client, store.add().id, { now: at(0) });
  assert.equal(r.status === "linked" && r.method, "created");
  assert.equal(srv.count("POST", "/projects"), 1);
});

test("a live project is matched even when archived duplicates sit beside it", async () => {
  const { srv, client, store } = setup();
  srv.addProject("100 Example Rd", "65775", { archived: true });
  const live = srv.addProject("100 Example Rd", "65775");
  const r = await ensureProject(store, client, store.add().id, { now: at(0) });
  assert.deepEqual(r, { status: "linked", method: "auto_match", projectId: live.id });
});

test("no match, several matches, a different zip, or a match another job owns: a new project is created", async () => {
  // zero matches and a different zip
  const a = setup(); a.srv.addProject("100 Example Rd", "65801");
  await ensureProject(a.store, a.client, a.store.add().id, { now: at(0) });
  assert.equal(a.srv.count("POST", "/projects"), 1);
  // two candidates: ambiguous, so never guess
  const b = setup(); b.srv.addProject("100 Example Rd", "65775"); b.srv.addProject("100 Example Road", "65775");
  const rb = await ensureProject(b.store, b.client, b.store.add().id, { now: at(0) });
  assert.equal(rb.status === "linked" && rb.method, "created");
  // the only candidate already belongs to another job
  const c = setup(); const owned = c.srv.addProject("100 Example Rd", "65775");
  c.store.add({ id: "owner", status: "linked", projectId: owned.id });
  const rc = await ensureProject(c.store, c.client, c.store.add({ id: "second", street: "100 Example Rd" }).id, { now: at(0) });
  assert.equal(rc.status === "linked" && rc.method, "created");
  assert.equal(c.store.jobs.find((j) => j.id === "owner")!.projectId, owned.id);   // untouched
});

test("a project is never linked to two jobs", async () => {
  const { srv, client, store } = setup();
  const p = srv.addProject("100 Example Rd", "65775");
  const first = store.add(), second = store.add();
  await ensureProject(store, client, first.id, { now: at(0) });
  await ensureProject(store, client, second.id, { now: at(0) });
  assert.equal(store.jobs[0].projectId, p.id);
  assert.notEqual(store.jobs[1].projectId, p.id);
  assert.equal(srv.count("POST", "/projects"), 1);            // the second job got its own
});

test("two syncs at once create exactly one project", async () => {
  const { srv, client, store } = setup();
  const job = store.add();
  const [a, b] = await Promise.all([ensureProject(store, client, job.id, { now: at(0) }), ensureProject(store, client, job.id, { now: at(0) })]);
  assert.equal(srv.count("POST", "/projects"), 1);
  assert.ok([a, b].some((r) => r.status === "linked"));
  assert.ok([a, b].every((r) => r.status === "linked" || r.status === "skipped" || r.status === "already_linked"));
});

// ---------- failures never break the caller ----------
test("a CompanyCam outage is recorded with a retry time and never thrown", async () => {
  const { srv, client, store } = setup();
  const job = store.add();
  srv.failNext(500);
  const r = await ensureProject(store, client, job.id, { now: at(0) });
  assert.equal(r.status, "error");
  assert.equal(r.status === "error" && r.kind, "server");
  const j = store.jobs[0];
  assert.deepEqual([j.status, j.attempts, j.error], ["error", 1, "CompanyCam had a problem"]);
  assert.equal(j.nextAttemptAt?.toISOString(), new Date(T0.getTime() + 60_000).toISOString());
  assert.equal(j.projectId, null);
});

test("each failure kind is recorded with a short fixed message and the right wait", async () => {
  const cases: [number, string, string, number][] = [
    [401, "auth", "CompanyCam rejected the access token", 1440], [429, "rate_limited", "CompanyCam is rate limiting requests", 120],
    [400, "bad_request", "CompanyCam rejected the project details", 1], [503, "server", "CompanyCam had a problem", 1],
  ];
  for (const [status, kind, message, minutes] of cases) {
    const { srv, client, store } = setup();
    const job = store.add();
    srv.failNext(status, status === 429 ? { "retry-after": "7200" } : undefined);
    const r = await ensureProject(store, client, job.id, { now: at(0) });
    assert.equal(r.status === "error" && r.kind, kind, String(status));
    assert.equal(store.jobs[0].error, message);
    assert.equal(store.jobs[0].nextAttemptAt?.getTime(), T0.getTime() + minutes * 60_000, String(status));
  }
  const { srv, client, store } = setup();
  const job = store.add();
  srv.down(true);
  const r = await ensureProject(store, client, job.id, { now: at(0) });
  assert.equal(r.status === "error" && r.kind, "network");
});

test("even a broken database cannot make it throw", async () => {
  const { client, store } = setup();
  const job = store.add();
  store.claim = async () => { throw new Error("db down"); };
  assert.equal((await ensureProject(store, client, job.id, { now: at(0) })).status, "error");
  const s2 = setup(); const j2 = s2.store.add();
  s2.srv.failNext(500);
  s2.store.setError = async () => { throw new Error("db down"); };
  assert.equal((await ensureProject(s2.store, s2.client, j2.id, { now: at(0) })).status, "error");
  const s3 = setup();
  s3.store.getJob = async () => { throw new Error("db down"); };
  assert.equal((await ensureProject(s3.store, s3.client, "x")).status, "error");
});

test("retries wait for the backoff, then succeed; force skips the wait but not an active attempt", async () => {
  const { srv, client, store } = setup();
  const job = store.add();
  srv.failNext(500);
  await ensureProject(store, client, job.id, { now: at(0) });
  const before = srv.requests.length;
  assert.deepEqual(await ensureProject(store, client, job.id, { now: at(30_000) }), { status: "skipped", reason: "busy" });   // 30 s: too soon
  assert.equal(srv.requests.length, before);
  const forced = await ensureProject(store, client, job.id, { now: at(30_000), force: true });
  assert.equal(forced.status, "linked");                      // a person pressing Retry doesn't wait
  assert.equal(store.jobs[0].attempts, 0);
  assert.equal(store.jobs[0].error, null);

  const b = setup(); const j2 = b.store.add();
  b.srv.failNext(500);
  await ensureProject(b.store, b.client, j2.id, { now: at(0) });
  assert.equal((await ensureProject(b.store, b.client, j2.id, { now: at(61_000) })).status, "linked");   // after the minute: automatic retry works
});

test("an attempt in progress blocks a second one until its lease runs out", async () => {
  const { srv, client, store } = setup();
  const job = store.add();
  await store.claim(job.id, T0, 180, { force: false, maxAttempts: MAX_ATTEMPTS });       // someone else is mid-sync
  assert.deepEqual(await ensureProject(store, client, job.id, { now: at(60_000), force: true }), { status: "skipped", reason: "busy" });
  assert.equal(srv.requests.length, 0);
  assert.equal((await ensureProject(store, client, job.id, { now: at(200_000) })).status, "linked");   // lease expired (crashed worker)
});

test("after too many failures it stops on its own; a person can still force it", async () => {
  const { srv, client, store } = setup();
  const job = store.add({ status: "error", attempts: MAX_ATTEMPTS, nextAttemptAt: new Date(T0.getTime() - 1000), error: "CompanyCam had a problem" });
  assert.deepEqual(await ensureProject(store, client, job.id, { now: at(0) }), { status: "skipped", reason: "gave_up" });
  assert.equal(srv.requests.length, 0);
  assert.equal((await ensureProject(store, client, job.id, { now: at(0), force: true })).status, "linked");
});

test("a duplicate-link race after creating is reported as an error, not a crash", async () => {
  const { srv, client, store } = setup();
  const job = store.add();
  const original = store.setLinked.bind(store);
  store.setLinked = async () => false;
  const r = await ensureProject(store, client, job.id, { now: at(0) });
  assert.equal(r.status, "error");
  store.setLinked = original;
  assert.equal(srv.count("POST", "/projects"), 1);
});

test("the sync list: unlinked, reviewed, open jobs that are due and not out of attempts", async () => {
  const { store } = setup();
  store.add({ id: "a" });
  store.add({ id: "linked", status: "linked", projectId: "1" });
  store.add({ id: "review", needsReview: true });
  store.add({ id: "lost", stage: "lost" });
  store.add({ id: "wait", status: "error", attempts: 2, nextAttemptAt: new Date(T0.getTime() + 60_000) });
  store.add({ id: "due", status: "error", attempts: 2, nextAttemptAt: new Date(T0.getTime() - 60_000) });
  store.add({ id: "done", status: "error", attempts: MAX_ATTEMPTS, nextAttemptAt: null });
  assert.deepEqual((await store.listNeedingSync(50, T0, MAX_ATTEMPTS)).map((j) => j.id), ["a", "due"]);
  assert.equal((await store.listNeedingSync(1, T0, MAX_ATTEMPTS)).length, 1);
});

// ---------- manual link and unlink ----------
test("manual link: an active project that no other job owns", async () => {
  const { srv, client, store } = setup();
  const p = srv.addProject("5 Somewhere Ln", "65775");
  const job = store.add();
  await linkProject(store, client, { jobId: job.id, projectId: p.id });
  assert.deepEqual([store.jobs[0].status, store.jobs[0].projectId, store.jobs[0].linkMethod], ["linked", p.id, "manual"]);
});

test("manual link refusals: not configured, unknown job or project, deleted, owned elsewhere, already linked, service down", async () => {
  const code = (p: Promise<unknown>) => p.then(() => "no error", (e: ManageError) => e.code);
  const { srv, client, store } = setup();
  const job = store.add();
  const p = srv.addProject("5 Somewhere Ln", "65775");
  assert.equal(await code(linkProject(store, null, { jobId: job.id, projectId: p.id })), "not_configured");
  assert.equal(await code(linkProject(store, client, { jobId: "nope", projectId: p.id })), "not_found");
  assert.equal(await code(linkProject(store, client, { jobId: job.id, projectId: "999999" })), "project_not_found");
  const gone = srv.addProject("6 Gone Ln", "65775", { status: "deleted" });
  assert.equal(await code(linkProject(store, client, { jobId: job.id, projectId: gone.id })), "project_deleted");
  store.add({ id: "other", status: "linked", projectId: p.id });
  assert.equal(await code(linkProject(store, client, { jobId: job.id, projectId: p.id })), "already_linked_elsewhere");
  const q = srv.addProject("7 Free Ln", "65775");
  srv.failNext(500);
  assert.equal(await code(linkProject(store, client, { jobId: job.id, projectId: q.id })), "service_error");
  await linkProject(store, client, { jobId: job.id, projectId: q.id });
  assert.equal(await code(linkProject(store, client, { jobId: job.id, projectId: q.id })), "already_linked");     // must unlink first
});

test("unlink removes the link only; the job can be linked again; nothing is deleted in CompanyCam", async () => {
  const code = (p: Promise<unknown>) => p.then(() => "no error", (e: ManageError) => e.code);
  const { srv, client, store } = setup();
  const job = store.add();
  assert.equal(await code(unlinkProject(store, job.id)), "not_linked");
  assert.equal(await code(unlinkProject(store, "nope")), "not_found");
  await ensureProject(store, client, job.id, { now: at(0) });
  const projectId = store.jobs[0].projectId!;
  await unlinkProject(store, job.id);
  assert.deepEqual([store.jobs[0].status, store.jobs[0].projectId], ["none", null]);
  assert.ok(srv.projects.some((p) => p.id === projectId));              // still in CompanyCam
  await linkProject(store, client, { jobId: job.id, projectId });       // relinking works
  assert.equal(store.jobs[0].projectId, projectId);
});

test("search to link: short queries return nothing; projects other jobs own are flagged", async () => {
  const { srv, client, store } = setup();
  const a = srv.addProject("12 Maple St", "65775"), b = srv.addProject("12 Maple Court", "65775");
  store.add({ status: "linked", projectId: a.id });
  assert.deepEqual(await searchForLink(store, client, "12"), []);
  const r = await searchForLink(store, client, "12 Maple");
  srv.addProject("12 Maple Lane", "65775", { archived: true });                 // archived projects are not offered for linking
  const r2 = await searchForLink(store, client, "12 Maple");
  assert.deepEqual(r2.map((x) => [x.id, x.linkedToJob]), [[a.id, true], [b.id, false]]);
  assert.deepEqual(r.map((x) => [x.id, x.linkedToJob]).slice(0, 2), [[a.id, true], [b.id, false]]);
  assert.match(r[0].address, /12 Maple St, West Plains, MO, 65775/);
  await assert.rejects(() => searchForLink(store, null, "12 Maple"), (e: ManageError) => e.code === "not_configured");
  srv.failNext(500);
  await assert.rejects(() => searchForLink(store, client, "12 Maple"), (e: ManageError) => e.code === "service_error");
});

// ---------- photos ----------
const photo = (id: string, capturedAt: string | null, thumb: string | null) =>
  ({ id, captured_at: capturedAt, creator_name: "Crew One", uris: [{ type: "original", uri: `https://img/original-${id}` }, ...(thumb ? [{ type: "thumbnail", uri: thumb }] : [])] });
const linked = (projectId = "7001") => ({ status: "linked" as const, projectId, projectUrl: "https://app.companycam.com/projects/7001", error: null });

test("photos: the newest eight thumbnails, count, never an original, none for unlinked jobs", async () => {
  clearPhotoCache();
  const { srv, client } = setup();
  srv.photos.set("7001", [
    ...Array.from({ length: 10 }, (_, i) => photo(`p${i}`, `2026-10-0${(i % 9) + 1}T12:00:00Z`, `https://img/t${i}`)),
    photo("nothumb", "2026-10-30T12:00:00Z", null),
  ]);
  const v = await photosFor(client, linked());
  assert.equal(v.state, "ok");
  if (v.state !== "ok") return;
  assert.equal(v.photos.length, 8);
  assert.equal(v.count, 11);
  assert.equal(v.hasMore, false);
  assert.ok(!JSON.stringify(v).includes("original"));
  assert.ok(!v.photos.some((p) => p.id === "nothumb"));              // no thumbnail, nothing to show
  const dates = v.photos.map((p) => p.capturedAt ?? "");
  assert.deepEqual(dates, [...dates].sort().reverse());              // newest first
  assert.deepEqual(await photosFor(client, { status: "none", projectId: null, projectUrl: null, error: null }), { state: "not_linked", status: "none", error: null });
  assert.deepEqual(await photosFor(client, { status: "error", projectId: null, projectUrl: null, error: "CompanyCam had a problem" }), { state: "not_linked", status: "error", error: "CompanyCam had a problem" });
  assert.deepEqual(await photosFor(null, linked()), { state: "not_configured" });
});

test("photos: cached for a minute, then refreshed; a full page says there are more", async () => {
  clearPhotoCache();
  const { srv, client } = setup();
  srv.photos.set("7002", Array.from({ length: 101 }, (_, i) => photo(`p${i}`, "2026-10-01T12:00:00Z", `https://img/t${i}`)));
  let clock = 1_000_000;
  const now = () => clock;
  const first = await photosFor(client, linked("7002"), now);
  assert.equal(first.state === "ok" && first.hasMore, true);
  await photosFor(client, linked("7002"), now);
  clock += 59_000;
  await photosFor(client, linked("7002"), now);
  assert.equal(srv.count("GET", "/projects/7002/photos"), 1);          // all three served from the cache
  clock += 2_000;
  await photosFor(client, linked("7002"), now);
  assert.equal(srv.count("GET", "/projects/7002/photos"), 2);
});

test("photos: a CompanyCam error becomes an error view with the project link, not a crash, and is not cached", async () => {
  clearPhotoCache();
  const { srv, client } = setup();
  srv.photos.set("7003", [photo("p1", "2026-10-01T12:00:00Z", "https://img/t1")]);
  srv.failNext(503);
  const bad = await photosFor(client, linked("7003"));
  assert.deepEqual(bad, { state: "error", kind: "server", projectUrl: "https://app.companycam.com/projects/7001" });
  const good = await photosFor(client, linked("7003"));
  assert.equal(good.state, "ok");                                      // the failure wasn't remembered
});

// ---------- who may do what ----------
const job = (over: Partial<ProductionJob> = {}): ProductionJob => ({
  id: "j1", jobNumber: 24, stage: "in_production", estimatorId: "est1", divisions: ["roofing", "siding"], customerName: "Dana Miller",
  propertyAddress: "100 Example Rd", contractSigned: true, depositRequiredCents: 0, depositPaidCents: 0, materialsOrderedAt: new Date(), poReference: "PO-1", ...over,
});
const trade = (division: "roofing" | "siding", status: TradeRow["status"], crewLeaderId: string | null = null): TradeRow => ({
  division, status, installDate: "2026-10-20", crewLeaderId, crewLeaderName: null, proposedBy: null, confirmedBy: null, startedAt: null, completedAt: null, notes: null,
});

test("who can see photos: admin, the job's estimator, a PM with a trade, an assigned crew leader; nobody else", () => {
  const trades = [trade("roofing", "scheduled", "crew1"), trade("siding", "proposed")];
  const see = (a: Actor, pm: ("roofing" | "siding" | "gutters")[] = []) => canSeePhotos(a, job(), trades, pm);
  assert.ok(see({ id: "adm", role: "admin" }));
  assert.ok(see({ id: "est1", role: "estimator" }));
  assert.ok(!see({ id: "est2", role: "estimator" }));
  assert.ok(see({ id: "pm", role: "production_manager" }, ["siding"]));
  assert.ok(!see({ id: "pm", role: "production_manager" }, ["gutters"]));
  assert.ok(see({ id: "crew1", role: "crew_leader" }));
  assert.ok(!see({ id: "crew2", role: "crew_leader" }));
  assert.ok(!see({ id: "csr", role: "csr" }));
  assert.ok(!see({ id: "acct", role: "accounting" }));
  // a crew leader assigned only to a trade that is merely proposed cannot see it yet
  assert.ok(!canSeePhotos({ id: "crew3", role: "crew_leader" }, job(), [trade("roofing", "proposed", "crew3")], []));
});

test("who can manage the link: admin and the job's own estimator; only admin unlinks", () => {
  assert.ok(canManageProject({ id: "adm", role: "admin" }, job()));
  assert.ok(canManageProject({ id: "est1", role: "estimator" }, job()));
  for (const a of [{ id: "est2", role: "estimator" }, { id: "pm", role: "production_manager" }, { id: "crew1", role: "crew_leader" }, { id: "csr", role: "csr" }] as Actor[]) {
    assert.ok(!canManageProject(a, job()), a.role);
  }
  assert.ok(canUnlinkProject({ id: "adm", role: "admin" }));
  assert.ok(!canUnlinkProject({ id: "est1", role: "estimator" }));
});