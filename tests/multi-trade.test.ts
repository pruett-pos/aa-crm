import { test } from "node:test";
import assert from "node:assert/strict";
import { ContractError, changeDivisions, prepareContract, selectPackage } from "../src/lib/contracts/sign.ts";
import { MemoryContractStore } from "../src/lib/contracts/memory-store.ts";
import { loadScopeData } from "../src/lib/scopes/load.ts";
import { MemoryScopeStore } from "../src/lib/scopes/memory-store.ts";
import { computeScope } from "../src/lib/scopes/service.ts";
import { loadContractInfo } from "../src/lib/contracts/load.ts";
import type { ContractJob } from "../src/lib/contracts/types.ts";
import type { StoredScope, Tier } from "../src/lib/scopes/types.ts";
import type { AuthUser } from "../src/lib/auth/store.ts";
import type { Division } from "../src/lib/rules.ts";

const scopeRec = (division: Division, tier: Tier, saleCents: number, productId: string | null = "p1"): StoredScope & { jobId: string } => ({
  id: `${division}-${tier}`, jobId: "j1", selected: false, division, tier, title: `${tier} ${division}`, targetMarginBps: 4000,
  costCents: Math.round(saleCents * 0.6), saleCents, marginBps: 4000,
  items: [{ kind: "material", sortOrder: 0, productId, description: `${division} work`, quantity: 1, unitCostCents: Math.round(saleCents * 0.6), unitPriceCents: saleCents, color: null }],
});
const baseJob = (over: Partial<ContractJob> = {}): ContractJob => ({
  id: "j1", jobNumber: 7, stage: "inspected", estimatorId: "est1", estimatorName: "Estimator One", divisions: ["roofing", "siding"],
  productionManagerId: null, contractCents: null, depositRequiredCents: 0,
  customerName: "Dana Miller", customerEmail: "dana@example.com", propertyAddress: "100 Example Rd", ...over,
});
function setup(job: Partial<ContractJob> = {}) {
  const s = new MemoryContractStore();
  s.jobs.push(baseJob(job));
  for (const d of ["roofing", "siding"] as const) {
    s.scopes.push(scopeRec(d, "good", 300_000), scopeRec(d, "better", 450_000));
  }
  return s;
}
const pick = (s: MemoryContractStore, division: Division, tier: Tier) =>
  selectPackage(s, "j1", division, tier, "est1", s.scopes.find((x) => x.division === division && x.tier === tier)!);
const code = (p: Promise<unknown>) => p.then(() => "no error", (e: ContractError) => e.code);

test("choosing a package for each trade builds up the job's contract and deposit", async () => {
  const s = setup();
  const first = await pick(s, "roofing", "good");
  assert.deepEqual([first.contractCents, first.depositRequiredCents], [300_000, 0]);   // $3,000 alone: no deposit
  assert.equal(s.jobs[0].stage, "scope_presented");
  const second = await pick(s, "siding", "good");
  assert.deepEqual([second.contractCents, second.costCents, second.depositRequiredCents], [600_000, 360_000, 300_000]); // $6,000 together: 50% deposit
  assert.deepEqual([s.jobs[0].contractCents, s.jobs[0].depositRequiredCents], [600_000, 300_000]);
  assert.deepEqual(second.selectedDivisions.sort(), ["roofing", "siding"]);
});

test("switching one trade's package changes only that trade", async () => {
  const s = setup();
  await pick(s, "roofing", "good");
  await pick(s, "siding", "good");
  await pick(s, "siding", "better");                         // siding goes from $3,000 to $4,500
  assert.equal(s.jobs[0].contractCents, 750_000);
  assert.deepEqual(
    s.scopes.filter((x) => x.selected).map((x) => `${x.division}:${x.tier}`).sort(), ["roofing:good", "siding:better"],
  );
  assert.equal(s.scopes.filter((x) => x.selected && x.division === "siding").length, 1);  // one chosen package per trade
});

test("the contract is blocked until every trade has a chosen package, and says which trade is missing", async () => {
  const s = setup();
  await pick(s, "roofing", "good");
  const err = await prepareContract(s, "j1").catch((e: ContractError) => e);
  assert.ok(err instanceof ContractError);
  assert.equal((err as ContractError).code, "divisions_incomplete");
  assert.match((err as ContractError).message, /Siding/);
  assert.doesNotMatch((err as ContractError).message, /Roofing/);
  assert.equal(s.docs.length, 0);
  await pick(s, "siding", "good");
  const doc = await prepareContract(s, "j1");
  assert.equal(doc.status, "draft");
  assert.ok(doc.unsignedData && doc.unsignedData.length > 500);
});

test("the contract info lists each trade with its package and whether all are chosen", async () => {
  const s = setup();
  await pick(s, "roofing", "better");
  let info = await loadContractInfo(s, "j1");
  assert.equal(info?.allTradesChosen, false);
  assert.deepEqual(info?.trades.map((t) => [t.division, t.selectedTier, t.subtotalCents]), [["roofing", "better", 450_000], ["siding", null, null]]);
  await pick(s, "siding", "good");
  info = await loadContractInfo(s, "j1");
  assert.equal(info?.allTradesChosen, true);
  assert.equal(info?.contractCents, 750_000);
});

test("editing a chosen package voids only that trade's choice, recalculates the job and cancels the draft contract", async () => {
  const s = setup();
  await pick(s, "roofing", "good");
  await pick(s, "siding", "good");
  const doc = await prepareContract(s, "j1");
  await s.clearSelectionIfSelected("j1", "siding", "good");
  assert.equal(s.jobs[0].contractCents, 300_000);              // roofing's package still counts
  assert.equal(s.jobs[0].depositRequiredCents, 0);             // and the combined deposit goes away
  assert.equal((await s.getDocument(doc.id))?.status, "cancelled");
  assert.equal(await code(prepareContract(s, "j1")), "divisions_incomplete");
  await s.clearSelectionIfSelected("j1", "roofing", "good");
  assert.deepEqual([s.jobs[0].contractCents, s.jobs[0].depositRequiredCents], [null, 0]);
  await s.clearSelectionIfSelected("j1", "roofing", "better");   // clearing something not chosen does nothing
  assert.equal(await code(prepareContract(s, "j1")), "no_selection");
});

test("a package for a trade that is not on the job is refused", async () => {
  const s = setup();
  s.scopes.push(scopeRec("gutters", "good", 100_000));
  assert.equal(await code(selectPackage(s, "j1", "gutters", "good", "est1", s.scopes.at(-1)!)), "division_not_on_job");
});

test("adding a trade: allowed once, not twice; invalid trades refused", async () => {
  const s = setup({ divisions: ["roofing"] });
  assert.deepEqual(await changeDivisions(s, { jobId: "j1", action: "add", division: "siding" }), ["roofing", "siding"]);
  assert.equal(await code(changeDivisions(s, { jobId: "j1", action: "add", division: "siding" })), "division_exists");
  assert.equal(await code(changeDivisions(s, { jobId: "j1", action: "add", division: "solar" })), "division_invalid");
  assert.equal(await code(changeDivisions(s, { jobId: "nope", action: "add", division: "gutters" })), "not_found");
});

test("removing a trade deletes its estimates, recalculates the totals and cancels the draft contract", async () => {
  const s = setup();
  await pick(s, "roofing", "good");
  await pick(s, "siding", "good");
  const doc = await prepareContract(s, "j1");
  assert.deepEqual(await changeDivisions(s, { jobId: "j1", action: "remove", division: "siding" }), ["roofing"]);
  assert.equal(s.scopes.some((x) => x.division === "siding"), false);
  assert.deepEqual([s.jobs[0].contractCents, s.jobs[0].depositRequiredCents], [300_000, 0]);
  assert.equal((await s.getDocument(doc.id))?.status, "cancelled");
  const again = await prepareContract(s, "j1");               // roofing is now the only trade and it is chosen
  assert.equal(again.status, "draft");
});

test("removing rules: never the last trade, only trades on the job, nothing after signing or on closed jobs", async () => {
  const s = setup({ divisions: ["roofing"] });
  assert.equal(await code(changeDivisions(s, { jobId: "j1", action: "remove", division: "roofing" })), "last_division");
  assert.equal(await code(changeDivisions(s, { jobId: "j1", action: "remove", division: "gutters" })), "division_not_on_job");

  const signed = setup();
  await pick(signed, "roofing", "good");
  await pick(signed, "siding", "good");
  const doc = await prepareContract(signed, "j1");
  doc.status = "signed";
  assert.equal(await code(changeDivisions(signed, { jobId: "j1", action: "remove", division: "siding" })), "already_signed");
  assert.equal(await code(changeDivisions(signed, { jobId: "j1", action: "add", division: "gutters" })), "already_signed");
  assert.equal(await code(pick(signed, "siding", "better")), "already_signed");

  const closed = setup({ stage: "lost" });
  assert.equal(await code(changeDivisions(closed, { jobId: "j1", action: "add", division: "gutters" })), "job_closed");
});

test("a single-trade job works exactly as before", async () => {
  const s = setup({ divisions: ["siding"] });
  const c = await pick(s, "siding", "good");
  assert.deepEqual([c.contractCents, c.depositRequiredCents], [300_000, 0]);
  const doc = await prepareContract(s, "j1");
  assert.equal(doc.status, "draft");
});

// ---------- what each person sees on the scope page ----------
const user = (id: string, role: AuthUser["role"]): AuthUser => ({ id, fullName: id, email: `${id}@x.com`, role, active: true });
function scopeWorld() {
  const s = new MemoryScopeStore();
  s.jobs.push({ id: "j1", stage: "contract_signed", divisions: ["roofing", "siding"], estimatorId: "est1", productionManagerId: null });
  s.managers.push({ division: "roofing", userId: "pm-roofing" }, { division: "siding", userId: "pm-siding" });
  s.products.push({ id: "p1", sku: "S1", name: "Shingles", unit: "sq", retailCents: 13_500, specialOrder: false });
  for (const d of ["roofing", "siding"] as const) {
    s.scopes.push({ ...scopeRec(d, "good", 300_000), selected: d === "roofing" });
  }
  return s;
}

test("scope page data: the estimator and admin see every trade; a PM sees only the trades they manage", async () => {
  const s = scopeWorld();
  const est = await loadScopeData(s, user("est1", "estimator"), "j1");
  assert.equal(est.status, "ok");
  if (est.status !== "ok") return;
  assert.deepEqual(est.divisions, ["roofing", "siding"]);
  assert.deepEqual(est.scopes.map((x) => x.division).sort(), ["roofing", "siding"]);
  assert.equal(est.scopes.find((x) => x.division === "roofing")?.selected, true);

  const pm = await loadScopeData(s, user("pm-siding", "production_manager"), "j1");
  assert.equal(pm.status, "ok");
  if (pm.status !== "ok") return;
  assert.deepEqual(pm.divisions, ["siding"]);
  assert.deepEqual(pm.scopes.map((x) => x.division), ["siding"]);
  assert.ok(pm.scopes[0].marginBps !== undefined);            // a PM sees margin for their own trade
  assert.equal(pm.canEdit, false);

  const other = await loadScopeData(s, user("pm-gutters", "production_manager"), "j1");
  assert.equal(other.status, "forbidden");                    // manages neither trade
  assert.equal((await loadScopeData(s, user("est2", "estimator"), "j1")).status, "forbidden");
  assert.equal((await loadScopeData(s, user("csr", "csr"), "j1")).status, "forbidden");
});

test("scope store: one set of packages per trade; saving the same trade and tier replaces it", async () => {
  const s = new MemoryScopeStore();
  s.jobs.push({ id: "j1", stage: "inspected", divisions: ["roofing", "siding"], estimatorId: "est1", productionManagerId: null });
  s.products.push({ id: "p1", sku: "S1", name: "Shingles", unit: "sq", retailCents: 13_500, specialOrder: false });
  const make = (division: Division, qty: number) => computeScope(
    { division, tier: "good", title: "Good", targetMarginBps: 4000, items: [{ kind: "material", productId: "p1", quantity: qty }] },
    s.products, ["roofing", "siding"],
  );
  await s.saveScope("j1", make("roofing", 10));
  await s.saveScope("j1", make("siding", 20));
  assert.equal((await s.listScopes("j1")).length, 2);        // same tier, different trades: two scopes
  await s.saveScope("j1", make("roofing", 30));
  const all = await s.listScopes("j1");
  assert.equal(all.length, 2);                               // same trade and tier: replaced, not duplicated
  assert.equal(all.find((x) => x.division === "roofing")?.items[0].quantity, 30);
});
