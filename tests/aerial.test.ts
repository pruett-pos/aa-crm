// Aerial roof estimate. Google is NEVER called from tests: every request goes to the fake below.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GoogleSolarError, createGoogleSolarClient, googleSolarConfigFromEnv, parseBuilding, type FetchLike,
} from "../src/integrations/google-solar/client.ts";
import {
  AerialError, DEFAULT_SETTINGS, aerialMeasurements, applyCorrection, ballpark, calibration, confidenceFor, fetchEstimateForJob,
  panelState, pitchFromDegrees, squaresX10, validateSettings,
} from "../src/lib/aerial/logic.ts";
import { MemoryAerialStore } from "../src/lib/aerial/memory-store.ts";
import type { AssemblyLine } from "../src/lib/estimating/assemblies.ts";
import type { Product } from "../src/lib/scopes/types.ts";
import { setLogSinks } from "../src/lib/ops/log.ts";

setLogSinks({ info: () => undefined, error: () => undefined });

const KEY = "AIza-test-key-do-not-log";
const HOUSE = { lat: 36.7281, lng: -91.8524 };

// ---------- the fake Google ----------
const segment = (areaMeters2: number, pitchDegrees: number, azimuthDegrees: number) => ({ pitchDegrees, azimuthDegrees, stats: { areaMeters2, groundAreaMeters2: areaMeters2 * 0.9 } });
const building = (quality: string, segments: ReturnType<typeof segment>[], whole?: number, center = HOUSE) => ({
  name: "buildings/abc", center: { latitude: center.lat, longitude: center.lng }, imageryDate: { year: 2024, month: 6, day: 9 }, imageryQuality: quality,
  solarPotential: { wholeRoofStats: { areaMeters2: whole ?? segments.reduce((s, x) => s + x.stats.areaMeters2, 0) }, roofSegmentStats: segments },
});
/** A plain gable: two planes at 26.57 degrees (6/12), 226.4 m2 = 2,437 sq ft. */
const GABLE = [segment(113.2, 26.57, 180), segment(113.2, 26.57, 0)];
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

type Answer = Response | (() => Response);
function fakeGoogle(o: {
  geocode?: Answer | Answer[];
  /** What the Solar API has at each quality level; a missing level answers 404. */
  solar?: Partial<Record<"HIGH" | "MEDIUM" | "BASE", unknown>>;
  solarAnswers?: Answer[];
  image?: Answer;
} = {}) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const take = (a: Answer | Answer[] | undefined, fallback: Response) => {
    const one = Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
    return one === undefined ? fallback : typeof one === "function" ? one() : one.clone();
  };
  const f: FetchLike = async (url) => {
    const u = new URL(url);
    assert.equal(u.searchParams.get("key"), KEY, "every request carries the key");
    if (u.hostname === "maps.googleapis.com" && u.pathname === "/maps/api/geocode/json") {
      calls.push("geocode");
      return take(o.geocode, json({ status: "OK", results: [{ geometry: { location: HOUSE, location_type: "ROOFTOP" } }] }));
    }
    if (u.hostname === "solar.googleapis.com" && u.pathname === "/v1/buildingInsights:findClosest") {
      const q = u.searchParams.get("requiredQuality") as "HIGH" | "MEDIUM" | "BASE";
      calls.push(`solar:${q}`);
      if (o.solarAnswers) return take(o.solarAnswers, json({}, 500));
      const have = (o.solar ?? { HIGH: building("HIGH", GABLE) })[q];
      return have ? json(have) : json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
    }
    if (u.hostname === "maps.googleapis.com" && u.pathname === "/maps/api/staticmap") {
      calls.push(`image:${u.searchParams.get("zoom")}:${u.searchParams.get("size")}:${u.searchParams.get("maptype")}`);
      return take(o.image, new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }));
    }
    throw new Error(`the fake does not know ${u.hostname}${u.pathname}`);
  };
  const logs: unknown[] = [];
  const client = createGoogleSolarClient({ apiKey: KEY, fetch: f, log: async (e) => { logs.push(e); } });
  return { client, calls, logs };
}
const noWait = async () => undefined;
function setup(google: Parameters<typeof fakeGoogle>[0] = {}) {
  const store = new MemoryAerialStore();
  const g = fakeGoogle(google);
  const job = store.addJob();
  const run = (jobId = job.id, opts: { force?: boolean } = {}) => fetchEstimateForJob({ store, client: g.client, sleep: noWait }, jobId, opts);
  return { store, job, run, ...g };
}
const down = () => new Response("oops", { status: 503 });

// ---------- pitch conversion ----------
test("pitch: degrees become rise over 12, rounded to a whole rise", () => {
  const cases: [number, string][] = [
    [0, "0/12"], [4.76, "1/12"], [18.43, "4/12"], [22.62, "5/12"], [26.57, "6/12"], [33.69, "8/12"], [36.87, "9/12"], [45, "12/12"],
    [27.9, "6/12"], [29.9, "7/12"],          // between whole pitches: the nearer one
    [89.9, "24/12"], [120, "24/12"],         // a wall or nonsense: capped
    [-3, "0/12"], [Number.NaN, "0/12"],
  ];
  for (const [deg, want] of cases) assert.equal(pitchFromDegrees(deg), want, `${deg} degrees`);
});

test("squares: 1 square is 100 sq ft, kept to a tenth", () => {
  assert.equal(squaresX10(2437), 244);      // 24.4 squares
  assert.equal(squaresX10(2449), 245);
  assert.equal(squaresX10(100), 10);
});

test("confidence comes from the imagery quality, and drops to low when the address was only approximated", () => {
  assert.deepEqual(["HIGH", "MEDIUM", "BASE", "LOW", ""].map((q) => confidenceFor(q, true)), ["high", "medium", "low", "low", "low"]);
  assert.equal(confidenceFor("HIGH", false), "low");
});

// ---------- the fetch ----------
test("normal roof: area, squares, pitch, quality, date, confidence, raw JSON and the picture are all saved on the property", async () => {
  const t = setup();
  assert.deepEqual(await t.run(), { status: "ok", attempts: 1, hasImage: true });
  assert.deepEqual(t.calls, ["geocode", "solar:HIGH", "image:20:640x640:satellite"]);
  const e = (await t.store.getEstimate(t.job.propertyId))!;
  assert.equal(e.status, "ok");
  assert.equal(e.rawAreaSqft, 2437);          // 226.4 m2 x 10.7639
  assert.equal(e.roofAreaSqft, 2437);
  assert.equal(e.squaresX10, 244);            // 24.4 squares
  assert.equal(e.mainPitch, "6/12");
  assert.equal(e.segmentCount, 2);
  assert.deepEqual(e.segments, [
    { areaSqft: 1218, pitch: "6/12", pitchDegrees: 26.6, azimuthDegrees: 180 },
    { areaSqft: 1218, pitch: "6/12", pitchDegrees: 26.6, azimuthDegrees: 0 },
  ]);
  assert.equal(e.imageryQuality, "HIGH");
  assert.equal(e.imageryDate, "2024-06-09");
  assert.equal(e.confidence, "high");
  assert.equal(e.correctionBps, 10_000);
  assert.ok(e.fetchedAt instanceof Date);
  assert.equal(e.hasImage, true);
  assert.deepEqual(await t.store.getImage(t.job.propertyId), { data: PNG, mime: "image/png" });
  assert.equal((t.store.rows.get(t.job.propertyId)!.raw as { name: string }).name, "buildings/abc");
});

test("multi-segment roof: every plane is kept, and the main pitch is the one covering the most area", async () => {
  const planes = [segment(60, 33.69, 90), segment(55, 33.69, 270), segment(40, 18.43, 180), segment(40, 18.43, 0), segment(12, 45, 135), segment(8, 4.76, 200)];
  // Google's whole-roof figure (230 m2) is a little more than the planes add up to (215 m2): the whole roof wins.
  const t = setup({ solar: { HIGH: building("HIGH", planes, 230) } });
  assert.equal((await t.run()).status, "ok");
  const e = (await t.store.getEstimate(t.job.propertyId))!;
  assert.equal(e.segmentCount, 6);
  assert.equal(e.rawAreaSqft, 2476);          // 230 m2
  assert.equal(e.squaresX10, 248);
  assert.equal(e.mainPitch, "8/12");          // 115 m2 at 8/12 beats 80 m2 at 4/12
  assert.deepEqual(e.segments!.map((s) => s.pitch), ["8/12", "8/12", "4/12", "4/12", "12/12", "1/12"]);   // biggest plane first
  assert.deepEqual(e.segments!.map((s) => s.azimuthDegrees), [90, 270, 180, 0, 135, 200]);
  assert.deepEqual(e.segments!.map((s) => s.areaSqft), [646, 592, 431, 431, 129, 86]);
});

test("not found: the address has no match, so the property is marked no aerial data and Google is not asked again", async () => {
  const t = setup({ geocode: new Response(JSON.stringify({ status: "ZERO_RESULTS", results: [] }), { status: 200 }) });
  assert.deepEqual(await t.run(), { status: "no_data", reason: "address_not_found", attempts: 1 });
  assert.deepEqual(t.calls, ["geocode"]);
  const e = (await t.store.getEstimate(t.job.propertyId))!;
  assert.equal(e.status, "no_data");
  assert.equal(e.error, "Google could not find this address");
  assert.equal(panelState(e, true), "no_data");
  assert.equal(e.roofAreaSqft, undefined);
});

test("not found: no building at any quality level is no aerial data, after asking each level exactly once", async () => {
  const t = setup({ solar: {} });
  assert.deepEqual(await t.run(), { status: "no_data", reason: "no_building", attempts: 1 });
  assert.deepEqual(t.calls, ["geocode", "solar:HIGH", "solar:MEDIUM", "solar:BASE"]);
  assert.equal((await t.store.getEstimate(t.job.propertyId))!.status, "no_data");
});

test("low-quality fallback: HIGH is missing so MEDIUM is used; when only BASE exists, confidence is low", async () => {
  const medium = setup({ solar: { MEDIUM: building("MEDIUM", GABLE) } });
  assert.equal((await medium.run()).status, "ok");
  assert.deepEqual(medium.calls.slice(0, 3), ["geocode", "solar:HIGH", "solar:MEDIUM"]);
  const m = (await medium.store.getEstimate(medium.job.propertyId))!;
  assert.deepEqual([m.imageryQuality, m.confidence], ["MEDIUM", "medium"]);

  const base = setup({ solar: { BASE: building("BASE", GABLE) } });
  assert.equal((await base.run()).status, "ok");
  assert.deepEqual(base.calls.slice(0, 4), ["geocode", "solar:HIGH", "solar:MEDIUM", "solar:BASE"]);
  const b = (await base.store.getEstimate(base.job.propertyId))!;
  assert.deepEqual([b.imageryQuality, b.confidence, b.squaresX10], ["BASE", "low", 244]);
});

test("skip when the property already has an estimate: a second booking makes no Google call", async () => {
  const t = setup();
  await t.run();
  const before = t.calls.length;
  const second = t.store.addJob({ propertyId: t.job.propertyId });
  assert.deepEqual(await t.run(second.id), { status: "skipped", reason: "already_has_one" });
  assert.equal(t.calls.length, before);
  // "No aerial data" also counts as already having one: Google is not asked on every later booking.
  const n = setup({ solar: {} });
  await n.run();
  const calls = n.calls.length;
  assert.deepEqual(await n.run(), { status: "skipped", reason: "already_has_one" });
  assert.equal(n.calls.length, calls);
});

test("two bookings at the same moment make one fetch", async () => {
  const t = setup();
  const other = t.store.addJob({ propertyId: t.job.propertyId });
  const results = await Promise.all([t.run(t.job.id), t.run(other.id)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["ok", "skipped"]);
  assert.equal(t.calls.filter((c) => c === "geocode").length, 1);
});

test("skips: paid Condition Reports, bookings with no appointment, the feature switched off, no API key, an unknown job", async () => {
  const t = setup();
  const report = t.store.addJob({ jobType: "condition_report" });
  assert.deepEqual(await t.run(report.id), { status: "skipped", reason: "condition_report" });
  const noAppointment = t.store.addJob({ appointmentAt: null });
  assert.deepEqual(await t.run(noAppointment.id), { status: "skipped", reason: "no_appointment" });
  assert.deepEqual(await t.run("nope"), { status: "skipped", reason: "not_found" });
  assert.deepEqual(await fetchEstimateForJob({ store: t.store, client: null }, t.job.id), { status: "skipped", reason: "not_configured" });
  t.store.settings.enabled = false;
  assert.deepEqual(await t.run(), { status: "skipped", reason: "disabled" });
  assert.deepEqual(t.calls, []);
  assert.equal(t.store.rows.size, 0);
  // Even an admin's "Fetch again" never fetches for a Condition Report.
  t.store.settings.enabled = true;
  assert.deepEqual(await t.run(report.id, { force: true }), { status: "skipped", reason: "condition_report" });
});

test("correction factor: the admin's factor is applied to the area and squares of estimates fetched afterwards", async () => {
  const t = setup();
  t.store.settings.correctionBps = 9500;      // aerial runs 5% big
  await t.run();
  const e = (await t.store.getEstimate(t.job.propertyId))!;
  assert.equal(e.rawAreaSqft, 2437);          // what Google measured is kept
  assert.equal(e.roofAreaSqft, 2315);         // 2437 x 0.95
  assert.equal(e.squaresX10, 232);            // 23.2 squares
  assert.equal(e.correctionBps, 9500);
  assert.equal(applyCorrection(2437, 10_800), 2632);

  // An estimate fetched before the change keeps the factor it was fetched with.
  const later = t.store.addJob({ propertyId: "p-later" });
  t.store.settings.correctionBps = 10_800;
  await t.run(later.id);
  assert.equal((await t.store.getEstimate("p-later"))!.roofAreaSqft, 2632);
  assert.equal((await t.store.getEstimate(t.job.propertyId))!.roofAreaSqft, 2315);
});

// ---------- failures ----------
test("API error: retried twice at most, then marked no aerial data, and nothing is thrown", async () => {
  const t = setup({ solarAnswers: [down] });
  assert.deepEqual(await t.run(), { status: "error", kind: "server", attempts: 3 });
  assert.deepEqual(t.calls, ["geocode", "solar:HIGH", "solar:HIGH", "solar:HIGH"]);        // first try + 2 retries, never a 4th
  const e = (await t.store.getEstimate(t.job.propertyId))!;
  assert.deepEqual([e.status, e.error, e.attempts], ["error", "Google had a problem", 3]);
  assert.equal(panelState(e, true), "no_data");                                            // the screen reads "No aerial data"
  // A later booking does not start the retries over.
  assert.deepEqual(await t.run(), { status: "skipped", reason: "already_has_one" });
  assert.equal(t.calls.length, 4);
});

test("API error: the two retries are shared by the whole estimate, and a passing failure recovers", async () => {
  const ok = () => new Response(JSON.stringify(building("HIGH", GABLE)), { status: 200 });
  const t = setup({ geocode: [down, new Response(JSON.stringify({ status: "OK", results: [{ geometry: { location: HOUSE, location_type: "ROOFTOP" } }] }))], solarAnswers: [down, ok] });
  assert.deepEqual(await t.run(), { status: "ok", attempts: 3, hasImage: true });
  assert.deepEqual(t.calls, ["geocode", "geocode", "solar:HIGH", "solar:HIGH", "image:20:640x640:satellite"]);

  // Both retries already spent on geocoding: the next failure is final.
  const spent = setup({ geocode: [down, down, new Response(JSON.stringify({ status: "OK", results: [{ geometry: { location: HOUSE, location_type: "ROOFTOP" } }] }))], solarAnswers: [down] });
  assert.deepEqual(await spent.run(), { status: "error", kind: "server", attempts: 3 });
  assert.deepEqual(spent.calls, ["geocode", "geocode", "geocode", "solar:HIGH"]);
});

test("API error: a rejected key and a bad request are never retried", async () => {
  const denied = setup({ geocode: new Response(JSON.stringify({ status: "REQUEST_DENIED", error_message: "The provided API key is invalid." }), { status: 200 }) });
  assert.deepEqual(await denied.run(), { status: "error", kind: "auth", attempts: 1 });
  assert.deepEqual(denied.calls, ["geocode"]);
  assert.equal((await denied.store.getEstimate(denied.job.propertyId))!.error, "Google rejected the API key");
  const forbidden = setup({ solarAnswers: [new Response("{}", { status: 403 })] });
  assert.deepEqual(await forbidden.run(), { status: "error", kind: "auth", attempts: 1 });
  assert.deepEqual(forbidden.calls, ["geocode", "solar:HIGH"]);
});

test("the booking is never broken: a network failure, a hung database and garbage from Google all come back as a result", async () => {
  const store = new MemoryAerialStore();
  const job = store.addJob();
  const dead = createGoogleSolarClient({ apiKey: KEY, fetch: async () => { throw new TypeError("fetch failed"); } });
  assert.deepEqual(await fetchEstimateForJob({ store, client: dead, sleep: noWait }, job.id), { status: "error", kind: "network", attempts: 3 });

  const broken = setup();
  broken.store.failWrites = true;
  assert.equal((await broken.run()).status, "error");

  const garbage = setup({ solarAnswers: [new Response("<html>not json</html>", { status: 200 })] });
  assert.equal((await garbage.run()).status, "error");

  const empty = setup({ solar: { HIGH: { name: "buildings/x", imageryQuality: "HIGH", solarPotential: {} } } });
  assert.deepEqual(await empty.run(), { status: "no_data", reason: "no_roof_area", attempts: 1 });
});

test("the picture is optional: when the image fails the numbers are still saved", async () => {
  const t = setup({ image: new Response("nope", { status: 400 }) });
  assert.deepEqual(await t.run(), { status: "ok", attempts: 1, hasImage: false });
  const e = (await t.store.getEstimate(t.job.propertyId))!;
  assert.deepEqual([e.status, e.hasImage, e.squaresX10], ["ok", false, 244]);
  // Not an image at all (an HTML error page with a 200): refused.
  const html = setup({ image: new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }) });
  assert.equal((await html.run()).status, "ok");
  assert.equal(await html.store.getImage(html.job.propertyId), null);
});

test("the wrong building is refused: an address Google can only place roughly, or a building too far from it", async () => {
  const geo = (location_type: string, loc = HOUSE) => new Response(JSON.stringify({ status: "OK", results: [{ geometry: { location: loc, location_type } }] }));
  const town = setup({ geocode: geo("APPROXIMATE") });
  assert.deepEqual(await town.run(), { status: "no_data", reason: "address_imprecise", attempts: 1 });
  assert.deepEqual(town.calls, ["geocode"]);
  // The closest building is about 330 m from the rooftop point: a neighbor's.
  const far = setup({ solar: { HIGH: building("HIGH", GABLE, undefined, { lat: HOUSE.lat + 0.003, lng: HOUSE.lng }) } });
  assert.deepEqual(await far.run(), { status: "no_data", reason: "too_far", attempts: 1 });
  // A point interpolated along the road is accepted (the house can sit back from it), but the confidence is low.
  const road = setup({ geocode: geo("RANGE_INTERPOLATED", { lat: HOUSE.lat + 0.001, lng: HOUSE.lng }) });
  assert.equal((await road.run()).status, "ok");
  assert.equal((await road.store.getEstimate(road.job.propertyId))!.confidence, "low");
});

test("an admin can fetch again after no aerial data, and that replaces the earlier result", async () => {
  const t = setup({ solar: {} });
  await t.run();
  const good = fakeGoogle();
  const again = await fetchEstimateForJob({ store: t.store, client: good.client, sleep: noWait }, t.job.id, { force: true });
  assert.equal(again.status, "ok");
  assert.equal((await t.store.getEstimate(t.job.propertyId))!.squaresX10, 244);
});

test("a fetch left half done by a restart is picked up again by the next booking, but a fresh one is left alone", async () => {
  const t = setup();
  const at = new Date("2026-11-11T12:00:00Z");
  await t.store.claim(t.job.propertyId, at, { staleBefore: at, force: false });
  assert.deepEqual(await fetchEstimateForJob({ store: t.store, client: t.client, sleep: noWait, now: () => new Date("2026-11-11T12:05:00Z") }, t.job.id), { status: "skipped", reason: "already_has_one" });
  assert.equal((await fetchEstimateForJob({ store: t.store, client: t.client, sleep: noWait, now: () => new Date("2026-11-11T12:11:00Z") }, t.job.id)).status, "ok");
});

// ---------- the client ----------
test("client: the API key and the address never reach a log or an error message", async () => {
  const t = setup({ solarAnswers: [down] });
  await t.run();
  const text = JSON.stringify(t.logs);
  assert.ok(t.logs.length >= 4);
  assert.ok(!text.includes(KEY) && !text.includes("Example Rd") && !text.includes("36.7281"));
  const g = fakeGoogle({ geocode: new Response("{}", { status: 500 }) });
  await assert.rejects(g.client.geocode("100 Example Rd, West Plains, MO 65775"), (e: unknown) => {
    assert.ok(e instanceof GoogleSolarError);
    assert.equal(e.kind, "server");
    assert.ok(!e.message.includes(KEY) && !e.message.includes("Example"));
    return true;
  });
});

test("client: no key in the environment means no client; a response is read defensively", () => {
  assert.equal(googleSolarConfigFromEnv({}), null);
  assert.equal(googleSolarConfigFromEnv({ GOOGLE_MAPS_API_KEY: "  " }), null);
  assert.deepEqual(googleSolarConfigFromEnv({ GOOGLE_MAPS_API_KEY: " k " }), { apiKey: "k" });
  const b = parseBuilding({
    imageryQuality: "medium", imageryDate: { year: 2023, month: 11 },
    solarPotential: { roofSegmentStats: [segment(50, 20, 10), { pitchDegrees: 20 }, { stats: { areaMeters2: -4 }, pitchDegrees: 3 }, null, { stats: { areaMeters2: 30 }, pitchDegrees: 0 }] },
  });
  assert.equal(b.imageryQuality, "MEDIUM");
  assert.equal(b.imageryDate, "2023-11-01");
  assert.equal(b.wholeRoofAreaM2, null);
  assert.equal(b.center, null);
  assert.deepEqual(b.segments, [{ areaM2: 50, pitchDegrees: 20, azimuthDegrees: 10 }, { areaM2: 30, pitchDegrees: 0, azimuthDegrees: null }]);
  assert.deepEqual(parseBuilding({}).segments, []);
});

// ---------- ballpark ----------
const products: Product[] = [
  { id: "shingle-good", sku: "S1", name: "3-tab shingles", unit: "sq", retailCents: 10_000, specialOrder: false },
  { id: "shingle-best", sku: "S3", name: "Designer shingles", unit: "sq", retailCents: 20_000, specialOrder: false },
  { id: "drip", sku: "D1", name: "Drip edge 10 ft", unit: "pc", retailCents: 1_000, specialOrder: false },
  { id: "ridge", sku: "R1", name: "Ridge cap", unit: "bdl", retailCents: 6_000, specialOrder: false },
];
const line = (tier: AssemblyLine["tier"], role: string, over: Partial<AssemblyLine>): AssemblyLine => ({
  tier, role, kind: "material", productId: null, description: null, unit: null, coverage: null, unitCostCents: null, sortOrder: 0, enabled: true, ...over,
});
const lines: AssemblyLine[] = [
  line("good", "shingles", { productId: "shingle-good" }), line("good", "drip_edge", { productId: "drip" }), line("good", "ridge_cap", { productId: "ridge" }),
  line("good", "install_shingles", { kind: "labor", unitCostCents: 9_000 }),
  line("best", "shingles", { productId: "shingle-best" }), line("best", "drip_edge", { productId: "drip" }), line("best", "ridge_cap", { productId: "ridge" }),
  line("best", "install_shingles", { kind: "labor", unitCostCents: 9_000 }),
];
const roof = { roofAreaSqft: 2000, rawAreaSqft: 2000, segmentCount: 2, segments: [{ areaSqft: 1000, pitch: "6/12", pitchDegrees: 26.6, azimuthDegrees: 0 }, { areaSqft: 1000, pitch: "6/12", pitchDegrees: 26.6, azimuthDegrees: 180 }] };

test("ballpark: edge and ridge lengths are filled in from the average feet per square, so those materials are priced", () => {
  const m = aerialMeasurements(roof, DEFAULT_SETTINGS);
  // 20 squares x 5.0 / 4.0 / 2.5 / 1.0 ft per square
  assert.deepEqual([m.eavesFt, m.rakesFt, m.ridgesHipsFt, m.valleysFt], [100, 80, 50, 20]);
  assert.deepEqual(m.pitches, [{ pitch: "6/12", areaSqft: 2000, percent: null }]);
  assert.equal(m.roofAreaSqft, 2000);
});

test("ballpark: Good to Best range from the package templates and the price book, squares plus the default waste", () => {
  const b = ballpark({ estimate: roof, settings: DEFAULT_SETTINGS, lines, products })!;
  assert.equal(b.wastePct, 10);
  // Good: 22 sq shingles (20 + 10%) at $88 cost (retail $100 less 12%), 18 drip edge at $8.80, 2 ridge cap at $52.80,
  // 20 sq labor at $90. Each line is priced at a 40% target margin (cost / 0.6).
  const price = (cost: number) => Math.round(cost / 0.6);
  const good = 22 * price(8_800) + 18 * price(880) + 2 * price(5_280) + 20 * price(9_000);
  const best = 22 * price(17_600) + 18 * price(880) + 2 * price(5_280) + 20 * price(9_000);
  assert.deepEqual(b.tiers, [{ tier: "good", saleCents: good }, { tier: "best", saleCents: best }]);   // no Better template: left out, not guessed
  assert.deepEqual([b.lowCents, b.highCents], [good, best]);
  assert.ok(Number.isInteger(b.lowCents) && Number.isInteger(b.highCents));                             // integer cents
  // Without the edge lengths the same roof prices lower: the edge and ridge materials really are in the number.
  const bare = ballpark({ estimate: roof, settings: { ...DEFAULT_SETTINGS, eavesFt10PerSq: 0, rakesFt10PerSq: 0, ridgesHipsFt10PerSq: 0, valleysFt10PerSq: 0 }, lines, products })!;
  assert.equal(good - bare.lowCents, 18 * price(880) + 2 * price(5_280));
});

test("ballpark: follows the price book and the waste setting, skips inactive products, and is null with nothing to price", () => {
  const base = ballpark({ estimate: roof, settings: DEFAULT_SETTINGS, lines, products })!;
  const dearer = ballpark({ estimate: roof, settings: DEFAULT_SETTINGS, lines, products: products.map((p) => (p.id === "shingle-good" ? { ...p, retailCents: 12_000 } : p)) })!;
  assert.ok(dearer.lowCents > base.lowCents);
  const moreWaste = ballpark({ estimate: roof, settings: { ...DEFAULT_SETTINGS, wasteBps: 2000 }, lines, products })!;
  assert.ok(moreWaste.lowCents > base.lowCents && moreWaste.wastePct === 20);
  const bigger = ballpark({ estimate: { ...roof, roofAreaSqft: 2200 }, settings: DEFAULT_SETTINGS, lines, products })!;      // a correction factor of 110%
  assert.ok(bigger.lowCents > base.lowCents);
  assert.equal(ballpark({ estimate: roof, settings: DEFAULT_SETTINGS, lines: [], products }), null);
  assert.equal(ballpark({ estimate: { ...roof, roofAreaSqft: 0 }, settings: DEFAULT_SETTINGS, lines, products }), null);
  const gone = ballpark({ estimate: roof, settings: DEFAULT_SETTINGS, lines, products: products.map((p) => ({ ...p, active: p.id !== "shingle-best" })) })!;
  assert.ok(gone.highCents < base.highCents);
});

// ---------- calibration ----------
const src = (jobNumber: number, aerialRawSqft: number, hoverSqft: number) => ({
  jobId: `j${jobNumber}`, jobNumber, street: `${jobNumber} Example Rd`, aerialRawSqft, hoverSqft,
  hoverEavesFt: hoverSqft / 20, hoverRakesFt: hoverSqft / 25, hoverRidgesHipsFt: hoverSqft / 40, hoverValleysFt: 0,
});

test("calibration: aerial vs Hover squares, the difference for each job, the average error and a suggested factor", () => {
  const c = calibration([src(1, 2100, 2000), src(2, 2850, 3000), src(3, 2600, 2500)]);
  assert.deepEqual(c.rows.map((r) => [r.jobNumber, r.aerialSquaresX10, r.hoverSquaresX10, r.diffBps]), [
    [1, 210, 200, 500],        // 21.0 vs 20.0 squares: +5%
    [2, 285, 300, -500],       // -5%
    [3, 260, 250, 400],        // +4%
  ]);
  assert.equal(c.avgDiffBps, 133);           // (+5 -5 +4) / 3 = +1.33%
  assert.equal(c.avgAbsDiffBps, 467);        // (5 + 5 + 4) / 3 = 4.67%
  assert.equal(c.suggestedCorrectionBps, 9934);   // 7500 Hover / 7550 aerial
  assert.deepEqual(c.hoverFt10PerSq, { eaves: 50, rakes: 40, ridgesHips: 25, valleys: 0 });
});

test("calibration: no jobs with both, or a Hover roof of zero, gives no averages instead of a divide by zero", () => {
  assert.deepEqual(calibration([]), { rows: [], avgDiffBps: null, avgAbsDiffBps: null, suggestedCorrectionBps: null, hoverFt10PerSq: null });
  assert.equal(calibration([src(1, 2000, 0)]).rows.length, 0);
  assert.equal(calibration([src(1, 9000, 2000)]).suggestedCorrectionBps, 5000);       // kept inside what the setting allows
});

// ---------- settings ----------
test("settings: percents become basis points and feet become tenths; out-of-range values are refused", () => {
  const ok = { enabled: true, wastePct: 12.5, correctionPct: 97.5, eavesFtPerSq: 5.2, rakesFtPerSq: 4, ridgesHipsFtPerSq: 2.5, valleysFtPerSq: 0 };
  assert.deepEqual(validateSettings(ok), {
    enabled: true, wasteBps: 1250, correctionBps: 9750, eavesFt10PerSq: 52, rakesFt10PerSq: 40, ridgesHipsFt10PerSq: 25, valleysFt10PerSq: 0,
  });
  for (const bad of [{ wastePct: 31 }, { wastePct: -1 }, { correctionPct: 49 }, { correctionPct: 151 }, { correctionPct: Number.NaN }, { eavesFtPerSq: 51 }, { valleysFtPerSq: -1 }]) {
    assert.throws(() => validateSettings({ ...ok, ...bad }), (e: unknown) => e instanceof AerialError && e.code === "invalid_settings", JSON.stringify(bad));
  }
  assert.equal(DEFAULT_SETTINGS.enabled, false);        // ships switched off
  assert.equal(panelState(null, false), "off");
  assert.equal(panelState(null, true), "none");
});
