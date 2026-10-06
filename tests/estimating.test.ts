import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoofingTiers, type AssemblyLine } from "../src/lib/estimating/assemblies.ts";
import {
  LABOR_ROLES, MATERIAL_ROLES, STEEP_PITCH_MIN, laborQuantity, materialQuantity, pitchRise, takeoffBasis, type LaborRole, type MaterialRole,
} from "../src/lib/estimating/roofing.ts";
import type { Measurements } from "../src/lib/measurements/types.ts";
import { computeScope } from "../src/lib/scopes/service.ts";
import type { Product, Tier } from "../src/lib/scopes/types.ts";
import { SCOPE_DEFAULT_TARGET_MARGIN_BPS, type Division } from "../src/lib/rules.ts";
import { MemoryAssemblyStore } from "../src/lib/estimating/memory-store.ts";
import { EstimatingError, buildScopesFromMeasurements, validateAssemblyEdit, type AssemblyEdit, type EstimatingDeps } from "../src/lib/estimating/service.ts";
import { MemoryMeasurementStore } from "../src/lib/measurements/memory-store.ts";
import { MemoryScopeStore } from "../src/lib/scopes/memory-store.ts";
import type { AuthUser } from "../src/lib/auth/store.ts";
import type { Role } from "../src/lib/auth/roles.ts";

/** The same roof as the measurements tests: 2,437 sq ft, 14 facets. */
const roof = (over: Partial<Measurements> = {}): Measurements => ({
  roofAreaSqft: 2437, facets: 14,
  pitches: [{ pitch: "6/12", areaSqft: 1800, percent: 73.9 }, { pitch: "8/12", areaSqft: 637, percent: 26.1 }],
  ridgesHipsFt: 126.5, valleysFt: 48.2, rakesFt: 88, eavesFt: 152.3, flashingFt: 20, stepFlashingFt: 31.7, sidingAreaSqft: null, ...over,
});

// ---------- the numbers everything starts from ----------
test("basis: squares, squares with waste, linear feet and the ice and water area", () => {
  const b = takeoffBasis(roof(), 10);
  assert.deepEqual(b, {
    squares: 24.37, wasteSquares: 26.81, eavesRakesFt: 240.3, ridgeHipFt: 126.5, valleyFt: 48.2,
    iceWaterSqft: 601.5,               // (152.3 + 48.2) ft x 3 ft wide
    steepSquares: 6.37,                // the 8/12 part of the roof
  });
});

test("basis: the waste allowance changes only the 'with waste' squares", () => {
  assert.equal(takeoffBasis(roof(), 0).wasteSquares, 24.37);
  assert.equal(takeoffBasis(roof(), 20).wasteSquares, 29.24);
  assert.equal(takeoffBasis(roof(), 20).squares, 24.37);
});

test("pitch: steep means 8/12 or more; odd strings count as not steep", () => {
  assert.equal(STEEP_PITCH_MIN, 8);
  assert.deepEqual(["8/12", "6.5/12", "12/12", "abc", ""].map(pitchRise), [8, 6.5, 12, null, null]);
  const steep = (pitch: string) => takeoffBasis(roof({ pitches: [{ pitch, areaSqft: 1000, percent: 100 }] }), 10).steepSquares;
  assert.deepEqual(["7/12", "7.9/12", "8/12", "12/12", "weird"].map(steep), [0, 0, 10, 10, 0]);
  assert.equal(takeoffBasis(roof({ pitches: [] }), 10).steepSquares, 0);
});

// ---------- materials ----------
test("materials: the worked example, every role rounded UP to whole units you can buy", () => {
  const b = takeoffBasis(roof(), 10);
  const q = Object.fromEntries(MATERIAL_ROLES.map((r) => [r, materialQuantity(r, b, null)]));
  assert.deepEqual(q, {
    shingles: 27,         // 26.81 squares
    starter: 3,           // 240.3 ft / 105 = 2.29 bundles
    ridge_cap: 4,         // 126.5 ft / 33 = 3.83 bundles
    underlayment: 3,      // 26.81 squares / 10 = 2.68 rolls
    ice_water: 4,         // 601.5 sq ft / 200 = 3.01 rolls
    drip_edge: 25,        // 240.3 ft / 10 = 24.03 pieces
    nails: 18,            // 26.81 squares / 1.5 = 17.9 boxes
  });
});

test("materials: an exact fit does not round up (99 ft of ridge is exactly 3 bundles of 33)", () => {
  const b = takeoffBasis(roof({ ridgesHipsFt: 99, eavesFt: 100, rakesFt: 110 }), 10);
  assert.equal(materialQuantity("ridge_cap", b, null), 3);
  assert.equal(materialQuantity("starter", b, null), 2);          // 210 / 105
  assert.equal(materialQuantity("drip_edge", b, null), 21);       // 210 / 10
  assert.equal(materialQuantity("ridge_cap", takeoffBasis(roof({ ridgesHipsFt: 99.1 }), 10), null), 4);       // a tenth over needs another
});

test("materials: your own coverage replaces the default; a blank or zero one falls back to it", () => {
  const b = takeoffBasis(roof(), 10);
  assert.equal(materialQuantity("starter", b, 120), 3);           // 240.3 / 120 = 2.0025
  assert.equal(materialQuantity("starter", b, 240.3), 1);
  assert.equal(materialQuantity("starter", b, 100), 3);
  for (const bad of [null, undefined, 0, -5]) assert.equal(materialQuantity("starter", b, bad), 3, String(bad));
  assert.equal(materialQuantity("shingles", b, 1 / 3), 81);       // priced by the bundle: 3 bundles to the square
});

test("materials: nothing to cover means nothing to order (no ridge, no valleys)", () => {
  const flat = takeoffBasis(roof({ ridgesHipsFt: 0, valleysFt: 0 }), 10);
  assert.equal(materialQuantity("ridge_cap", flat, null), 0);
  assert.equal(materialQuantity("ice_water", flat, null), 3);     // eaves alone: 152.3 x 3 = 456.9 sq ft / 200
  const none = takeoffBasis(roof({ ridgesHipsFt: 0, valleysFt: 0, eavesFt: 0, rakesFt: 0 }), 10);
  for (const r of ["starter", "ridge_cap", "ice_water", "drip_edge"] as MaterialRole[]) assert.equal(materialQuantity(r, none, null), 0, r);
});

test("materials: waste changes what to order for area-based roles only", () => {
  const at = (pct: number) => takeoffBasis(roof(), pct);
  assert.deepEqual([0, 10, 20].map((p) => materialQuantity("shingles", at(p), null)), [25, 27, 30]);
  assert.deepEqual([0, 10, 20].map((p) => materialQuantity("starter", at(p), null)), [3, 3, 3]);
});

// ---------- labor ----------
test("labor: squares to two decimals on measured area, feet rounded up to a whole foot", () => {
  const b = takeoffBasis(roof(), 10);
  const q = Object.fromEntries(LABOR_ROLES.map((r) => [r, laborQuantity(r, b)]));
  assert.deepEqual(q, { tear_off: 24.37, install_shingles: 24.37, ridge_cap_labor: 127, valley_labor: 49, steep_labor: 6.37 });
});

test("labor: waste never inflates what the crew is paid for; zero means no line", () => {
  assert.equal(laborQuantity("tear_off", takeoffBasis(roof(), 0)), laborQuantity("tear_off", takeoffBasis(roof(), 25)));
  const none = takeoffBasis(roof({ ridgesHipsFt: 0, valleysFt: 0, pitches: [] }), 10);
  for (const r of ["ridge_cap_labor", "valley_labor", "steep_labor"] as LaborRole[]) assert.equal(laborQuantity(r, none), 0, r);
});

// ---------- the assembly ----------
const P = (id: string, name: string, unit: string, retail: number): Product => ({ id, sku: id.toUpperCase(), name, unit, retailCents: retail, specialOrder: false });
const catalog = [
  P("vista", "Architectural shingles - Vista", "sq", 11_800), P("highlander", "Architectural shingles - Highlander", "sq", 13_500), P("designer", "Designer shingles", "sq", 17_900),
  P("starter", "Starter strip", "bundle", 4_800), P("ridge", "Ridge cap shingles", "bundle", 5_900), P("under", "Synthetic underlayment", "roll", 11_500),
  P("ice", "Ice and water shield", "roll", 9_800), P("drip", "Drip edge 10 ft", "ea", 1_150), P("nails", "Roofing nails 5 lb box", "ea", 2_600),
];
const mat = (tier: Tier, role: string, productId: string | null, sortOrder: number, over: Partial<AssemblyLine> = {}): AssemblyLine => ({
  tier, role, kind: "material", productId, description: null, unit: null, coverage: null, unitCostCents: null, sortOrder, enabled: true, ...over,
});
const lab = (tier: Tier, role: string, cents: number | null, sortOrder: number, over: Partial<AssemblyLine> = {}): AssemblyLine => ({
  tier, role, kind: "labor", productId: null, description: null, unit: null, coverage: null, unitCostCents: cents, sortOrder, enabled: true, ...over,
});
const shingle = { good: "vista", better: "highlander", best: "designer" } as const;
const fullLines = (): AssemblyLine[] => (["good", "better", "best"] as const).flatMap((t) => [
  mat(t, "shingles", shingle[t], 1), mat(t, "starter", "starter", 2), mat(t, "ridge_cap", "ridge", 3), mat(t, "underlayment", "under", 4),
  mat(t, "ice_water", "ice", 5), mat(t, "drip_edge", "drip", 6), mat(t, "nails", "nails", 7),
  lab(t, "tear_off", 1800, 10, { description: "Tear off and haul away" }), lab(t, "install_shingles", 2600, 11), lab(t, "ridge_cap_labor", 150, 12),
  lab(t, "valley_labor", 120, 13), lab(t, "steep_labor", 500, 14),
]);
const build = (lines: AssemblyLine[], m = roof(), waste = 10) => buildRoofingTiers({ measurements: m, wastePct: waste, lines, products: catalog });

test("assembly: three tiers with the right shingle, titles, quantities from the takeoff, and labor with units", () => {
  const { tiers, skipped } = build(fullLines());
  assert.deepEqual(skipped, []);
  assert.deepEqual(tiers.map((t) => [t.tier, t.title]), [["good", "Good - Architectural shingles - Vista"], ["better", "Better - Architectural shingles - Highlander"], ["best", "Best - Designer shingles"]]);
  const good = tiers[0].items;
  assert.deepEqual(good.map((i) => [i.kind, i.productId ?? i.description, i.quantity, i.unit ?? null]), [
    ["material", "vista", 27, null], ["material", "starter", 3, null], ["material", "ridge", 4, null], ["material", "under", 3, null],
    ["material", "ice", 4, null], ["material", "drip", 25, null], ["material", "nails", 18, null],
    ["labor", "Tear off and haul away", 24.37, "sq"], ["labor", "Install shingles", 24.37, "sq"], ["labor", "Install ridge and hip cap", 127, "lf"],
    ["labor", "Install valleys", 49, "lf"], ["labor", "Steep roof labor", 6.37, "sq"],
  ]);
  assert.deepEqual(good.filter((i) => i.kind === "labor").map((i) => i.unitCostCents), [1800, 2600, 150, 120, 500]);
});

test("assembly: no price is ever set here; the server prices every line", () => {
  const json = JSON.stringify(build(fullLines()));
  assert.ok(!/unitPrice|salePrice|saleCents|margin/i.test(json));
  for (const t of build(fullLines()).tiers) for (const i of t.items) assert.ok(i.kind === "material" ? i.unitCostCents === undefined : i.unitCostCents !== undefined);
});

test("assembly: a role with no product, a product that isn't in the catalog, or a labor line with no rate is left out and reported", () => {
  const lines = [
    mat("good", "shingles", "vista", 1), mat("good", "starter", null, 2), mat("good", "ridge_cap", "not-in-catalog", 3),
    lab("good", "tear_off", 1800, 10), lab("good", "install_shingles", null, 11),
  ];
  const { tiers, skipped } = build(lines);
  assert.deepEqual(tiers[0].items.map((i) => i.productId ?? i.description), ["vista", "Tear off existing roof"]);
  assert.deepEqual(skipped, [{ tier: "good", role: "starter", reason: "no_product" }, { tier: "good", role: "ridge_cap", reason: "no_product" }, { tier: "good", role: "install_shingles", reason: "no_rate" }]);
});

test("assembly: disabled lines are ignored; unknown roles are reported; a $0 rate is a real rate", () => {
  const lines = [
    mat("good", "shingles", "vista", 1), mat("good", "starter", "starter", 2, { enabled: false }), mat("good", "mystery", "vista", 3),
    lab("good", "tear_off", 0, 10), lab("good", "mystery_labor", 100, 11),
  ];
  const { tiers, skipped } = build(lines);
  assert.deepEqual(tiers[0].items.map((i) => i.productId ?? i.description), ["vista", "Tear off existing roof"]);
  assert.equal(tiers[0].items[1].unitCostCents, 0);
  assert.deepEqual(skipped.map((s) => [s.role, s.reason]), [["mystery", "unknown_role"], ["mystery_labor", "unknown_role"]]);
});

test("assembly: a role with nothing to do on this roof is reported as not needed, not ordered as zero", () => {
  const { tiers, skipped } = build(fullLines(), roof({ ridgesHipsFt: 0, valleysFt: 0, pitches: [{ pitch: "6/12", areaSqft: 2437, percent: 100 }] }));
  const roles = tiers[0].items.map((i) => i.productId ?? i.description);
  assert.ok(!roles.includes("ridge") && !roles.includes("Install ridge and hip cap") && !roles.includes("Install valleys") && !roles.includes("Steep roof labor"));
  assert.ok(roles.includes("ice"));                                           // eaves still need it
  assert.deepEqual([...new Set(skipped.map((s) => s.reason))], ["not_needed"]);
  assert.equal(skipped.filter((s) => s.tier === "good").length, 4);
  assert.ok(tiers[0].items.every((i) => i.quantity > 0));
});

test("assembly: a tier with no usable lines is left out entirely; with no settings at all nothing is built", () => {
  const lines = [...fullLines().filter((l) => l.tier !== "better"), mat("better", "shingles", null, 1)];
  const { tiers, skipped } = build(lines);
  assert.deepEqual(tiers.map((t) => t.tier), ["good", "best"]);
  assert.deepEqual(skipped, [{ tier: "better", role: "shingles", reason: "no_product" }]);
  assert.deepEqual(build([]), { tiers: [], skipped: [] });
});

test("assembly: the title falls back to the tier name when no shingle is set; lines keep the settings' order", () => {
  const { tiers } = build([lab("good", "install_shingles", 2600, 2), lab("good", "tear_off", 1800, 1)]);
  assert.equal(tiers[0].title, "Good");
  assert.deepEqual(tiers[0].items.map((i) => i.description), ["Tear off existing roof", "Install shingles"]);
});

test("assembly: labor units are cleaned; a custom unit and description are used", () => {
  const { tiers } = build([lab("good", "tear_off", 1800, 1, { unit: " SQ ", description: "  Tear-off  " })]);
  assert.deepEqual([tiers[0].items[0].unit, tiers[0].items[0].description], ["sq", "Tear-off"]);
});

test("assembly: the draft goes through the normal scope pricing: cost from the catalog and rates, price from the target margin", () => {
  const built = build(fullLines()).tiers[0];
  const scope = computeScope({ division: "roofing", tier: "good", title: built.title, targetMarginBps: SCOPE_DEFAULT_TARGET_MARGIN_BPS, items: built.items }, catalog, ["roofing"]);
  assert.equal(scope.items.length, built.items.length);
  const labor = scope.items.filter((i) => i.kind === "labor");
  assert.deepEqual(labor.map((i) => i.unit), ["sq", "sq", "lf", "lf", "sq"]);
  assert.ok(scope.items.filter((i) => i.kind === "material").every((i) => i.unit === null));
  const cost = scope.items.reduce((s, i) => s + Math.round(i.quantity * i.unitCostCents), 0);
  assert.ok(Math.abs(scope.costCents - cost) <= scope.items.length);
  assert.ok(scope.saleCents > scope.costCents);
  assert.ok(Math.abs(scope.marginBps - SCOPE_DEFAULT_TARGET_MARGIN_BPS) < 100);        // within a point: each line price is rounded
  // materials cost the Pruett Builder price (retail less 12%), not retail
  assert.equal(scope.items[0].unitCostCents, Math.round(11_800 * 0.88));
});

test("a labor line's unit must be letters: bad units are refused when the scope is computed", () => {
  const items = [{ kind: "labor" as const, description: "x", quantity: 1, unitCostCents: 100, unit: "sq ft!" }];
  assert.throws(() => computeScope({ division: "roofing", tier: "good", title: "t", targetMarginBps: 4000, items }, catalog, ["roofing"]), /unit should be 1 to 8 letters/);
  const ok = computeScope({ division: "roofing", tier: "good", title: "t", targetMarginBps: 4000, items: [{ ...items[0], unit: undefined }, { ...items[0], unit: " LF " }] }, catalog, ["roofing"]);
  assert.deepEqual(ok.items.map((i) => i.unit), ["ea", "lf"]);
});

// ---------- building the scopes for a job ----------
const user = (id: string, role: Role): AuthUser => ({ id, fullName: id, email: `${id}@x.com`, role, active: true });
const adm = user("adm", "admin"), est1 = user("est1", "estimator"), est2 = user("est2", "estimator"), pm = user("pm", "production_manager"), csr = user("csr", "csr");
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof EstimatingError ? e.code : `other:${String(e)}`));

function setup(opts: { divisions?: Division[]; lines?: AssemblyLine[]; measure?: boolean } = {}) {
  const scopes = new MemoryScopeStore();
  scopes.jobs.push({ id: "j1", stage: "inspected", divisions: opts.divisions ?? ["roofing"], estimatorId: "est1", productionManagerId: null });
  scopes.products = catalog;
  const measurements = new MemoryMeasurementStore();
  measurements.addJob({ id: "j1" });
  const assemblies = new MemoryAssemblyStore();
  for (const l of opts.lines ?? fullLines()) assemblies.rows.push({ ...l, updatedBy: null });
  const calls: string[] = [];
  let signed = false;
  const contracts: EstimatingDeps["contracts"] = {
    async hasSignedContract() { return signed; },
    async clearSelectionIfSelected(_j, d, tier) { calls.push(`clear:${d}:${tier}`); },
  };
  const deps: EstimatingDeps = { scopes, measurements, assemblies, contracts };
  return { deps, scopes, measurements, assemblies, calls, sign: () => { signed = true; }, addMeasurement: () => measurements.insert("j1", { ...roof(), source: "manual", hoverJobId: null, hoverModelId: null, raw: null, note: null, createdBy: "est1" }) };
}
const A = { jobId: "j1", division: "roofing", wastePct: 10, replace: false };

test("build: three scopes saved through the normal path, selection cleared, summary returned", async () => {
  const s = setup(); await s.addMeasurement();
  const r = await buildScopesFromMeasurements(s.deps, est1, A);
  assert.deepEqual(r.tiers.map((t) => [t.tier, t.lineCount]), [["good", 12], ["better", 12], ["best", 12]]);
  assert.deepEqual([r.skipped, r.replaced], [[], false]);
  assert.deepEqual(s.calls, ["clear:roofing:good", "clear:roofing:better", "clear:roofing:best"]);
  const saved = await s.scopes.listScopes("j1");
  assert.equal(saved.length, 3);
  assert.ok(saved.every((x) => x.targetMarginBps === SCOPE_DEFAULT_TARGET_MARGIN_BPS && x.saleCents > x.costCents && x.selected === false));
  const better = saved.find((x) => x.tier === "better")!;
  assert.equal(better.items[0].quantity, 27);
  assert.equal(better.items.find((i) => i.description === "Install shingles")?.unit, "sq");
  assert.equal(better.title, "Better - Architectural shingles - Highlander");
});

test("build: the newest measurement is the one used", async () => {
  const s = setup();
  await s.addMeasurement();
  await s.measurements.insert("j1", { ...roof({ roofAreaSqft: 5000 }), source: "manual", hoverJobId: null, hoverModelId: null, raw: null, note: null, createdBy: "est1" });
  await buildScopesFromMeasurements(s.deps, adm, A);
  assert.equal((await s.scopes.listScopes("j1")).find((x) => x.tier === "good")!.items[0].quantity, 55);        // 5000 sq ft + 10% = 55 squares
});

test("build: only admin and the job's own estimator", async () => {
  const s = setup(); await s.addMeasurement();
  for (const who of [est2, pm, csr]) assert.equal(await code(buildScopesFromMeasurements(s.deps, who, A)), "forbidden", who.id);
  assert.equal((await s.scopes.listScopes("j1")).length, 0);
  assert.equal(await code(buildScopesFromMeasurements(s.deps, est1, A)), "ok");
  assert.equal(await code(buildScopesFromMeasurements(s.deps, adm, { ...A, replace: true })), "ok");
});

test("build: refusals, each leaving everything as it was", async () => {
  const s = setup();
  assert.equal(await code(buildScopesFromMeasurements(s.deps, adm, A)), "no_measurements");
  await s.addMeasurement();
  assert.equal(await code(buildScopesFromMeasurements(s.deps, adm, { ...A, jobId: "nope" })), "not_found");
  assert.equal(await code(buildScopesFromMeasurements(s.deps, adm, { ...A, division: "siding" })), "division_not_supported");
  for (const bad of [-1, 31, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(await code(buildScopesFromMeasurements(s.deps, adm, { ...A, wastePct: bad })), "invalid_waste", String(bad));
  const noRoofing = setup({ divisions: ["siding"] }); await noRoofing.addMeasurement();
  assert.equal(await code(buildScopesFromMeasurements(noRoofing.deps, adm, A)), "division_not_supported");
  s.sign();
  assert.equal(await code(buildScopesFromMeasurements(s.deps, adm, A)), "contract_signed");
  assert.equal((await s.scopes.listScopes("j1")).length, 0);
  assert.deepEqual(s.calls, []);
});

test("build: hand-built work is not replaced unless asked; an empty draft doesn't count as work", async () => {
  const s = setup(); await s.addMeasurement();
  await s.deps.scopes.saveScope("j1", computeScope({ division: "roofing", tier: "good", title: "Mine", targetMarginBps: 4000, items: [{ kind: "labor", description: "My work", quantity: 1, unitCostCents: 100 }] }, catalog, ["roofing"]));
  assert.equal(await code(buildScopesFromMeasurements(s.deps, est1, A)), "scope_exists");
  assert.equal((await s.scopes.listScopes("j1"))[0].title, "Mine");
  const r = await buildScopesFromMeasurements(s.deps, est1, { ...A, replace: true });
  assert.equal(r.replaced, true);
  assert.equal((await s.scopes.listScopes("j1")).find((x) => x.tier === "good")!.title, "Good - Architectural shingles - Vista");
  const empty = setup(); await empty.addMeasurement();
  await empty.deps.scopes.saveScope("j1", computeScope({ division: "roofing", tier: "good", title: "Blank", targetMarginBps: 4000, items: [] }, catalog, ["roofing"]));
  assert.equal(await code(buildScopesFromMeasurements(empty.deps, est1, A)), "ok");
});

test("build: settings with nothing usable are refused and say what is missing", async () => {
  const s = setup({ lines: [mat("good", "shingles", null, 1), lab("good", "tear_off", null, 2)] }); await s.addMeasurement();
  const err = await buildScopesFromMeasurements(s.deps, adm, A).catch((e: EstimatingError) => e);
  assert.ok(err instanceof EstimatingError && err.code === "no_assembly");
  assert.deepEqual(err.skipped, [{ tier: "good", role: "shingles", reason: "no_product" }, { tier: "good", role: "tear_off", reason: "no_rate" }]);
  const none = setup({ lines: [] }); await none.addMeasurement();
  assert.equal(await code(buildScopesFromMeasurements(none.deps, adm, A)), "no_assembly");
});

test("build: partly filled settings still build, and list what was left for the estimator", async () => {
  const s = setup({ lines: fullLines().filter((l) => !(l.tier === "good" && l.role === "starter")) }); await s.addMeasurement();
  const r = await buildScopesFromMeasurements(s.deps, adm, A);
  assert.equal(r.tiers.length, 3);
  assert.equal(r.tiers[0].lineCount, 11);
});

test("build: a tier that can't be priced stops everything before anything is saved", async () => {
  const lines = fullLines().map((l) => (l.tier === "best" && l.role === "tear_off" ? { ...l, unitCostCents: 200_000_000 } : l));      // over the per-unit limit
  const s = setup({ lines }); await s.addMeasurement();
  await s.deps.scopes.saveScope("j1", computeScope({ division: "roofing", tier: "good", title: "Mine", targetMarginBps: 4000, items: [{ kind: "labor", description: "My work", quantity: 1, unitCostCents: 100 }] }, catalog, ["roofing"]));
  const err = await buildScopesFromMeasurements(s.deps, adm, { ...A, replace: true }).catch((e: EstimatingError) => e);
  assert.ok(err instanceof EstimatingError && err.code === "invalid_scope" && /best/.test(err.message));
  assert.deepEqual((await s.scopes.listScopes("j1")).map((x) => x.title), ["Mine"]);        // the existing scope is untouched
  assert.deepEqual(s.calls, []);
});

// ---------- assembly settings validation ----------
const known = new Set(catalog.map((p) => p.id));
const edit = (over: Partial<AssemblyEdit> = {}): AssemblyEdit => ({ tier: "good", role: "starter", productId: "starter", description: null, unit: null, coverage: 105, unitCostCents: null, enabled: true, ...over });
const fails = (e: AssemblyEdit) => { try { validateAssemblyEdit(e, known); return "ok"; } catch (x) { return x instanceof EstimatingError ? `${x.code}:${x.message}` : "other"; } };

test("settings: a material row keeps its product and coverage; a labor row keeps its description, unit and rate", () => {
  assert.deepEqual(validateAssemblyEdit(edit({ description: "ignored", unit: "ea", unitCostCents: 99 }), known),
    { tier: "good", role: "starter", productId: "starter", description: null, unit: null, coverage: 105, unitCostCents: null, enabled: true, kind: "material" });
  assert.deepEqual(validateAssemblyEdit(edit({ role: "tear_off", productId: null, coverage: 7, description: "  Tear-off  ", unit: " SQ ", unitCostCents: 1800 }), known),
    { tier: "good", role: "tear_off", productId: null, description: "Tear-off", unit: "sq", coverage: null, unitCostCents: 1800, enabled: true, kind: "labor" });
  assert.equal(validateAssemblyEdit(edit({ role: "tear_off", productId: null, unitCostCents: 0 }), known).unitCostCents, 0);       // free is allowed
  assert.equal(validateAssemblyEdit(edit({ coverage: null, productId: null }), known).coverage, null);                                 // blank coverage: the default is used
});

test("settings: bad rows are refused with a reason", () => {
  assert.match(fails(edit({ tier: "platinum" as Tier })), /^invalid_assembly:Unknown package tier/);
  assert.match(fails(edit({ role: "mystery" })), /Unknown role/);
  assert.match(fails(edit({ productId: "not-in-catalog" })), /Pick a product/);
  for (const bad of [0, -1, Number.NaN, 100_001]) assert.match(fails(edit({ coverage: bad })), /Coverage/, String(bad));
  const labor = (o: Partial<AssemblyEdit>) => edit({ role: "tear_off", productId: null, coverage: null, ...o });
  for (const bad of [-1, 1.5, Number.NaN, 200_000_000]) assert.match(fails(labor({ unitCostCents: bad })), /rate/, String(bad));
  assert.match(fails(labor({ unit: "sq ft" })), /unit/);
  assert.match(fails(labor({ description: "x".repeat(201) })), /too long/);
  assert.match(fails(labor({ productId: "starter" })), /no catalog product/);
});