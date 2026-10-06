import { test } from "node:test";
import assert from "node:assert/strict";
import { HoverError, type HoverJob } from "../src/integrations/hover/client.ts";
import {
  canEditMeasurements, canViewMeasurements, importHoverMeasurements, measurementsLocked, measurementView, saveManualMeasurements, searchHover, type HoverSource,
} from "../src/lib/measurements/logic.ts";
import { MemoryMeasurementStore } from "../src/lib/measurements/memory-store.ts";
import { MeasurementError, parseHoverMeasurements, squares, squaresWithWaste, validateMeasurements } from "../src/lib/measurements/parse.ts";
import type { Measurements } from "../src/lib/measurements/types.ts";
import type { Actor } from "../src/lib/production/types.ts";

const adm: Actor = { id: "adm", role: "admin" };
const est1: Actor = { id: "est1", role: "estimator" };
const est2: Actor = { id: "est2", role: "estimator" };
const pmRoof: Actor = { id: "pmr", role: "production_manager" };
const pmGutter: Actor = { id: "pmg", role: "production_manager" };
const crew: Actor = { id: "crew1", role: "crew_leader" };
const csr: Actor = { id: "csr", role: "csr" };
const acct: Actor = { id: "acct", role: "accounting" };

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof MeasurementError ? e.code : `other:${String(e)}`));

/** Shaped like the documented response of GET /api/v3/models/{id}/artifacts/measurements.json. */
const hoverJson = (over: Record<string, unknown> = {}) => ({
  roof: {
    roof_facets: { area: 2437, total: 14 },
    ridges_hips: { length: 126.5, total: 7 },
    valleys: { length: 48.2, total: 3 },
    rakes: { length: 88, total: 4 },
    gutters_eaves: { length: 152.3, total: 6 },
    flashing: { length: 20, total: 2 },
    step_flashing: { length: 31.7, total: 2 },
    pitch: [{ roof_pitch: "6/12", area: 1800, percentage: 73.9 }, { roof_pitch: "8/12", area: 637, percentage: "26.1" }],
    waste_factor: { area: { zero: 2437, plus_10_percent: 2681 } },
    ...(over.roof as object),
  },
  area: { total: { siding: 2950, other: 120 }, facades: { siding: 2950, other: 120 } },
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "roof")),
});

// ---------- units ----------
test("units: squares are area / 100; waste adds a percentage to the area first", () => {
  assert.equal(squares(2437), 24.37);
  assert.equal(squares(2437.4), 24.37);
  assert.equal(squaresWithWaste(2437, 10), 26.81);          // 2437 x 1.10 = 2680.7 sq ft
  assert.equal(squaresWithWaste(2000, 0), 20);
  assert.equal(squaresWithWaste(1000, 15), 11.5);
});

// ---------- parsing Hover ----------
test("hover: a typical response becomes our measurements", () => {
  assert.deepEqual(parseHoverMeasurements(hoverJson()), {
    roofAreaSqft: 2437, facets: 14,
    pitches: [{ pitch: "6/12", areaSqft: 1800, percent: 73.9 }, { pitch: "8/12", areaSqft: 637, percent: 26.1 }],
    ridgesHipsFt: 126.5, valleysFt: 48.2, rakesFt: 88, eavesFt: 152.3, flashingFt: 20, stepFlashingFt: 31.7, sidingAreaSqft: 2950,
  });
});

test("hover: lengths are rounded to a tenth of a foot and area to a whole foot", () => {
  const m = parseHoverMeasurements(hoverJson({ roof: { roof_facets: { area: 2436.6, total: 14.4 }, ridges_hips: { length: 126.4999, total: 7 } } }));
  assert.deepEqual([m.roofAreaSqft, m.facets, m.ridgesHipsFt], [2437, 14, 126.5]);
});

test("hover: pieces Hover leaves out count as zero; a flat addition has no ridge and no pitch table", () => {
  const m = parseHoverMeasurements({ roof: { roof_facets: { area: 400 } } });
  assert.deepEqual([m.ridgesHipsFt, m.valleysFt, m.rakesFt, m.eavesFt, m.flashingFt, m.stepFlashingFt, m.pitches, m.facets, m.sidingAreaSqft], [0, 0, 0, 0, 0, 0, [], null, null]);
});

test("hover: totals sent as a list of pieces are added up; numbers sent as text are accepted", () => {
  const m = parseHoverMeasurements({
    roof: { roof_facets: [{ area: 1000 }, { area: "500" }], ridges_hips: [{ length: 10.5 }, { length: 20 }, { length: "bad" }], valleys: "12.5" },
    area: { total: { siding: "1500" } },
  });
  assert.deepEqual([m.roofAreaSqft, m.ridgesHipsFt, m.valleysFt, m.sidingAreaSqft], [1500, 30.5, 12.5, 1500]);
});

test("hover: no roof, or no roof area, is refused with a clear reason", () => {
  for (const bad of [null, undefined, "text", 5, [], {}, { roof: null }, { roof: "x" }]) assert.throws(() => parseHoverMeasurements(bad), (e: MeasurementError) => e.code === "no_roof_data");
  for (const bad of [{ roof: {} }, { roof: { roof_facets: {} } }, { roof: { roof_facets: { area: 0 } } }, { roof: { roof_facets: { area: -5 } } }, { roof: { roof_facets: { area: "lots" } } }, { roof: { roof_facets: [] } }]) {
    assert.throws(() => parseHoverMeasurements(bad), (e: MeasurementError) => e.code === "no_roof_area", JSON.stringify(bad));
  }
});

test("hover: impossible values are refused, never stored", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["roofAreaSqft", { roof: { roof_facets: { area: 250_000 } } }],
    ["ridgesHipsFt", { roof: { ridges_hips: { length: -1 } } }],
    ["rakesFt", { roof: { rakes: { length: 600_000 } } }],
    ["pitches.0.areaSqft", { roof: { pitch: [{ roof_pitch: "6/12", area: 999_999 }] } }],
    ["pitches.0.pitch", { roof: { pitch: [{ roof_pitch: "steep", area: 100 }] } }],
    ["sidingAreaSqft", { area: { total: { siding: 900_000 } } }],
  ];
  for (const [field, over] of cases) {
    assert.throws(() => parseHoverMeasurements(hoverJson(over)), (e: MeasurementError) => e.code === "invalid_value" && e.field === field, field);
  }
  assert.throws(() => parseHoverMeasurements(hoverJson({ roof: { pitch: Array.from({ length: 13 }, () => ({ roof_pitch: "6/12", area: 10 })) } })), (e: MeasurementError) => e.code === "invalid_value" && e.field === "pitches");
});

test("hover: pitch entries without a pitch or an area are skipped; decimal pitches are fine", () => {
  const m = parseHoverMeasurements(hoverJson({ roof: { pitch: [{ area: 5 }, { roof_pitch: "6/12" }, { roof_pitch: "6.5/12", area: 700 }] } }));
  assert.deepEqual(m.pitches, [{ pitch: "6.5/12", areaSqft: 700, percent: null }]);
});

// ---------- typed-in values ----------
const manual = (over: Partial<Measurements> = {}): Measurements => ({
  roofAreaSqft: 2400, facets: null, pitches: [{ pitch: "6/12", areaSqft: 2400, percent: 100 }], ridgesHipsFt: 120, valleysFt: 40, rakesFt: 80,
  eavesFt: 150, flashingFt: 0, stepFlashingFt: 0, sidingAreaSqft: null, ...over,
});

test("typed in: the same checks as Hover's numbers", () => {
  assert.equal(validateMeasurements(manual({ roofAreaSqft: 2400.4, ridgesHipsFt: 120.04 })).roofAreaSqft, 2400);
  assert.throws(() => validateMeasurements(manual({ roofAreaSqft: 0 })), (e: MeasurementError) => e.code === "no_roof_area");
  assert.throws(() => validateMeasurements(manual({ valleysFt: -1 })), (e: MeasurementError) => e.code === "invalid_value" && e.field === "valleysFt");
  assert.throws(() => validateMeasurements(manual({ eavesFt: Number.NaN })), (e: MeasurementError) => e.code === "invalid_value");
  assert.throws(() => validateMeasurements(manual({ rakesFt: Number.POSITIVE_INFINITY })), (e: MeasurementError) => e.code === "invalid_value");
  assert.throws(() => validateMeasurements(manual({ pitches: [{ pitch: "13", areaSqft: 5, percent: null }] })), (e: MeasurementError) => e.field === "pitches.0.pitch");
  assert.throws(() => validateMeasurements(manual({ facets: 6000 })), (e: MeasurementError) => e.field === "facets");
  assert.equal(validateMeasurements({ ...manual(), roofAreaSqft: "2400" as unknown as number }).roofAreaSqft, 2400);        // numbers typed into a form arrive as text
  assert.throws(() => validateMeasurements({ ...manual(), roofAreaSqft: "lots" as unknown as number }), (e: MeasurementError) => e.code === "invalid_value");
});

// ---------- rights ----------
test("rights: admin and the job's estimator edit; a PM with a trade on the job can look; nobody else", () => {
  const job = { estimatorId: "est1", divisions: ["roofing" as const] };
  assert.ok(canEditMeasurements(adm, job) && canEditMeasurements(est1, job));
  for (const a of [est2, pmRoof, crew, csr, acct]) assert.ok(!canEditMeasurements(a, job), a.id);
  assert.ok(canViewMeasurements(adm, job, []) && canViewMeasurements(est1, job, []));
  assert.ok(canViewMeasurements(pmRoof, job, ["roofing"]) && !canViewMeasurements(pmGutter, job, ["gutters"]));
  for (const a of [est2, crew, csr, acct]) assert.ok(!canViewMeasurements(a, job, ["roofing"]), a.id);
});

test("locked: measurements can change only before the contract is signed, never on a closed job", () => {
  for (const stage of ["new_lead", "appointment_set", "inspected", "scope_presented"] as const) assert.equal(measurementsLocked({ stage }), false, stage);
  for (const stage of ["contract_signed", "deposit_collected", "in_production", "invoiced", "paid_in_full", "lost", "cancelled_after_approval"] as const) assert.equal(measurementsLocked({ stage }), true, stage);
});

// ---------- manual save and view ----------
test("manual: saved with who and when; the newest is current and older ones are kept as history", async () => {
  const s = new MemoryMeasurementStore();
  const job = s.addJob();
  const a = await saveManualMeasurements(s, est1, job.id, manual(), "  measured on site  ");
  assert.deepEqual([a.source, a.note, a.squares], ["manual", "measured on site", 24]);
  assert.deepEqual(a.wasteSquares, [{ pct: 5, squares: 25.2 }, { pct: 10, squares: 26.4 }, { pct: 15, squares: 27.6 }, { pct: 20, squares: 28.8 }]);
  await saveManualMeasurements(s, adm, job.id, manual({ roofAreaSqft: 2600 }));
  const v = await measurementView(s, est1, job.id);
  assert.deepEqual([v.current?.roofAreaSqft, v.history.map((h) => h.roofAreaSqft), v.canEdit, v.locked, v.job.address], [2600, [2400], true, false, "100 Example Rd, West Plains 65775"]);
  assert.ok(!JSON.stringify(v).includes("raw"));
  assert.equal(s.rows[0].createdBy, "est1");
});

test("manual and view: roles, a missing job, and locked jobs", async () => {
  const s = new MemoryMeasurementStore();
  const job = s.addJob();
  s.pm.set("pmr", ["roofing"]); s.pm.set("pmg", ["gutters"]);
  for (const who of [est2, crew, csr, acct, pmGutter]) {
    assert.equal(await code(saveManualMeasurements(s, who, job.id, manual())), "forbidden", who.id);
    assert.equal(await code(measurementView(s, who, job.id)), "forbidden", who.id);
  }
  assert.equal(await code(saveManualMeasurements(s, pmRoof, job.id, manual())), "forbidden");       // a PM may look, not change
  assert.equal(await code(measurementView(s, pmRoof, job.id)), "ok");
  assert.equal(await code(saveManualMeasurements(s, adm, "nope", manual())), "not_found");
  assert.equal(await code(measurementView(s, adm, "nope")), "not_found");
  assert.equal(s.rows.length, 0);
  for (const stage of ["contract_signed", "lost"] as const) {
    const locked = s.addJob({ stage });
    assert.equal(await code(saveManualMeasurements(s, adm, locked.id, manual())), "locked", stage);
    assert.equal((await measurementView(s, adm, locked.id)).canEdit, false);
  }
  assert.equal(await code(saveManualMeasurements(s, adm, job.id, manual({ roofAreaSqft: 0 }))), "no_roof_area");
});

// ---------- hover search and import ----------
const hjob = (over: Partial<HoverJob> = {}): HoverJob => ({
  id: "H1", name: "Miller roof", state: "completed", externalId: null,
  address: { street: "100 Example Road", city: "West Plains", state: "MO", postalCode: "65775" },
  models: [{ id: "M1", state: "complete" }], ...over,
});
function fakeHover(jobs: HoverJob[], measurements: unknown = hoverJson()) {
  const calls: string[] = [];
  const h: HoverSource & { calls: string[] } = {
    calls,
    async listJobs(q) { calls.push(`list:${q}`); return jobs; },
    async getMeasurements(id) { calls.push(`measure:${id}`); return measurements; },
  };
  return h;
}

test("search: defaults to the job's street; a matching address (any spelling) sorts first and shows its ready model", async () => {
  const s = new MemoryMeasurementStore();
  const job = s.addJob();
  const h = fakeHover([
    hjob({ id: "H2", address: { street: "5 Elsewhere St", city: "X", state: "MO", postalCode: "65775" } }),
    hjob({ id: "H1", models: [{ id: "M0", state: "uploading" }, { id: "M1", state: "complete" }, { id: "M2", state: "failed" }] }),
    hjob({ id: "H3", state: "draft", address: { street: "100 Example Rd", city: "West Plains", state: "MO", postalCode: "65775" }, models: [] }),
  ]);
  const r = await searchHover(s, h, est1, job.id);
  assert.deepEqual(h.calls, ["list:100 Example Rd"]);
  assert.deepEqual(r.map((c) => [c.hoverJobId, c.addressMatches, c.readyModelId]), [["H1", true, "M1"], ["H3", true, null], ["H2", false, "M1"]]);
  assert.equal(r[0].address, "100 Example Road, West Plains, MO, 65775");
  await searchHover(s, h, est1, job.id, "  Miller  ");
  assert.equal(h.calls[1], "list:Miller");
});

test("search: Hover not connected, search too short, Hover down, and who may search", async () => {
  const s = new MemoryMeasurementStore();
  const job = s.addJob();
  assert.equal(await code(searchHover(s, null, est1, job.id)), "hover_not_connected");
  assert.equal(await code(searchHover(s, fakeHover([]), est1, job.id, "ab")), "search_too_short");
  const authFail: HoverSource = { async listJobs() { throw new HoverError("auth", "x"); }, async getMeasurements() { return {}; } };
  const down: HoverSource = { async listJobs() { throw new HoverError("server", "x"); }, async getMeasurements() { return {}; } };
  assert.equal(await code(searchHover(s, authFail, est1, job.id)), "hover_not_connected");
  assert.equal(await code(searchHover(s, down, est1, job.id)), "hover_error");
  for (const who of [est2, pmRoof, crew, csr, acct]) assert.equal(await code(searchHover(s, fakeHover([]), who, job.id)), "forbidden", who.id);
  const locked = s.addJob({ stage: "contract_signed" });
  assert.equal(await code(searchHover(s, fakeHover([]), adm, locked.id)), "locked");
});

test("import: fetches the chosen model, stores the parsed numbers with the raw JSON and the Hover ids", async () => {
  const s = new MemoryMeasurementStore();
  const job = s.addJob();
  const h = fakeHover([hjob()]);
  const row = await importHoverMeasurements(s, h, est1, { jobId: job.id, hoverJobId: "H1", modelId: "M1" });
  assert.deepEqual(h.calls, ["list:100 Example Rd", "measure:M1"]);
  assert.deepEqual([row.source, row.roofAreaSqft, row.squares, row.ridgesHipsFt, row.sidingAreaSqft], ["hover", 2437, 24.37, 126.5, 2950]);
  const stored = s.rows[0];
  assert.deepEqual([stored.hoverJobId, stored.hoverModelId, stored.createdBy], ["H1", "M1", "est1"]);
  assert.deepEqual(stored.raw, hoverJson());
  assert.ok(!JSON.stringify(await measurementView(s, est1, job.id)).includes("roof_facets"));      // the raw JSON never goes to a screen
});

test("import: only a job and model Hover itself listed for that search can be imported", async () => {
  const s = new MemoryMeasurementStore();
  const job = s.addJob();
  const h = fakeHover([hjob()]);
  assert.equal(await code(importHoverMeasurements(s, h, adm, { jobId: job.id, hoverJobId: "OTHER", modelId: "M1" })), "no_match");
  assert.equal(await code(importHoverMeasurements(s, h, adm, { jobId: job.id, hoverJobId: "H1", modelId: "NOT-ON-JOB" })), "no_match");
  assert.ok(!h.calls.some((c) => c.startsWith("measure")));        // nothing was fetched
  assert.equal(await code(importHoverMeasurements(s, h, adm, { jobId: job.id, hoverJobId: "H1", modelId: "M1", query: "ab" })), "search_too_short");
  assert.equal(s.rows.length, 0);
});

test("import: a model Hover hasn't finished is refused", async () => {
  const s = new MemoryMeasurementStore();
  const job = s.addJob();
  for (const j of [hjob({ state: "draft" }), hjob({ models: [{ id: "M1", state: "uploading" }] }), hjob({ state: "failed" })]) {
    assert.equal(await code(importHoverMeasurements(s, fakeHover([j]), adm, { jobId: job.id, hoverJobId: "H1", modelId: "M1" })), "model_not_ready");
  }
  assert.equal(s.rows.length, 0);
});

test("import: bad data from Hover is refused with nothing saved; Hover errors become clear ones", async () => {
  const s = new MemoryMeasurementStore();
  const job = s.addJob();
  const args = { jobId: job.id, hoverJobId: "H1", modelId: "M1" };
  assert.equal(await code(importHoverMeasurements(s, fakeHover([hjob()], { roof: null }), adm, args)), "no_roof_data");
  assert.equal(await code(importHoverMeasurements(s, fakeHover([hjob()], hoverJson({ roof: { roof_facets: { area: 9_999_999 } } })), adm, args)), "invalid_value");
  const failing = (kind: "auth" | "not_found" | "network"): HoverSource => ({ async listJobs() { return [hjob()]; }, async getMeasurements() { throw new HoverError(kind, "x"); } });
  assert.equal(await code(importHoverMeasurements(s, failing("auth"), adm, args)), "hover_not_connected");
  assert.equal(await code(importHoverMeasurements(s, failing("not_found"), adm, args)), "hover_error");
  assert.equal(await code(importHoverMeasurements(s, failing("network"), adm, args)), "hover_error");
  assert.equal(await code(importHoverMeasurements(s, null, adm, args)), "hover_not_connected");
  assert.equal(await code(importHoverMeasurements(s, fakeHover([hjob()]), est2, args)), "forbidden");
  assert.equal(await code(importHoverMeasurements(s, fakeHover([hjob()]), adm, { ...args, jobId: "nope" })), "not_found");
  assert.equal(s.rows.length, 0);
});
