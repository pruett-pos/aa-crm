import { test } from "node:test";
import assert from "node:assert/strict";
import { jobStageFromProduction } from "../src/lib/production/stages.ts";
import { checkInstallDate } from "../src/lib/production/dates.ts";
import { depositGateMet, jobRights, tradeRights } from "../src/lib/production/rights.ts";
import { buildMaterialList, materialTable } from "../src/lib/production/materials.ts";
import {
  ProductionError, completeTrade, confirmInstall, mergeTrades, productionView, proposeInstall, recordMaterialsOrder,
  saveSelections, scheduleBoard, startTrade,
} from "../src/lib/production/logic.ts";
import { MemoryProductionStore } from "../src/lib/production/memory-store.ts";
import { toCsv } from "../src/lib/reports/csv.ts";
import type { Actor, ProductionJob, TradeStatus } from "../src/lib/production/types.ts";
import type { StoredScope } from "../src/lib/scopes/types.ts";
import type { Division } from "../src/lib/rules.ts";

const NOW = () => new Date("2026-10-14T17:00:00Z"); // Wednesday Oct 14, noon Central
const EST1: Actor = { id: "est1", role: "estimator" };
const EST2: Actor = { id: "est2", role: "estimator" };
const ADMIN: Actor = { id: "adm", role: "admin" };
const PM_ROOF: Actor = { id: "pm-roof", role: "production_manager" };
const PM_SIDE: Actor = { id: "pm-side", role: "production_manager" };
const CREW1: Actor = { id: "crew1", role: "crew_leader" };
const CREW2: Actor = { id: "crew2", role: "crew_leader" };
const CSR: Actor = { id: "csr", role: "csr" };
const code = (p: Promise<unknown>) => p.then(() => "no error", (e: ProductionError) => e.code);

// ---------- stage machine ----------
test("stages: materials ordered -> scheduled -> in production -> closeout, per trade", () => {
  const t = (...s: TradeStatus[]) => s;
  assert.equal(jobStageFromProduction("deposit_collected", { materialsOrdered: true, trades: t("not_scheduled", "not_scheduled") }), "materials_ordered");
  assert.equal(jobStageFromProduction("materials_ordered", { materialsOrdered: true, trades: t("scheduled", "proposed") }), null);            // one trade still unconfirmed
  assert.equal(jobStageFromProduction("materials_ordered", { materialsOrdered: true, trades: t("scheduled", "scheduled") }), "scheduled");
  assert.equal(jobStageFromProduction("scheduled", { materialsOrdered: true, trades: t("in_production", "scheduled") }), "in_production");   // first trade started
  assert.equal(jobStageFromProduction("in_production", { materialsOrdered: true, trades: t("complete", "in_production") }), null);
  assert.equal(jobStageFromProduction("in_production", { materialsOrdered: true, trades: t("complete", "scheduled") }), null);               // second trade not started yet
  assert.equal(jobStageFromProduction("in_production", { materialsOrdered: true, trades: t("complete", "complete") }), "closeout_punchlist");
});

test("stages: never backward, no change when nothing applies, closed jobs untouched", () => {
  assert.equal(jobStageFromProduction("in_production", { materialsOrdered: true, trades: ["scheduled"] }), null);        // would be "scheduled": backward
  assert.equal(jobStageFromProduction("invoiced", { materialsOrdered: true, trades: ["complete"] }), null);              // already past closeout
  assert.equal(jobStageFromProduction("contract_signed", { materialsOrdered: false, trades: ["not_scheduled"] }), null);
  assert.equal(jobStageFromProduction("deposit_collected", { materialsOrdered: false, trades: [] }), null);
  assert.equal(jobStageFromProduction("lost", { materialsOrdered: true, trades: ["complete"] }), null);
  assert.equal(jobStageFromProduction("cancelled_after_approval", { materialsOrdered: true, trades: ["complete"] }), null);
  assert.equal(jobStageFromProduction("closeout_punchlist", { materialsOrdered: true, trades: ["complete"] }), null);    // idempotent
});

test("stages: a single-trade job goes straight through", () => {
  assert.equal(jobStageFromProduction("materials_ordered", { materialsOrdered: true, trades: ["scheduled"] }), "scheduled");
  assert.equal(jobStageFromProduction("scheduled", { materialsOrdered: true, trades: ["in_production"] }), "in_production");
  assert.equal(jobStageFromProduction("in_production", { materialsOrdered: true, trades: ["complete"] }), "closeout_punchlist");
});

// ---------- dates ----------
test("install dates: real, not in the past, within a year (Central today)", () => {
  assert.equal(checkInstallDate("2026-10-14", "2026-10-14"), null);          // today is fine
  assert.equal(checkInstallDate("2026-10-13", "2026-10-14"), "in_the_past");
  assert.equal(checkInstallDate("2027-10-14", "2026-10-14"), null);          // exactly a year
  assert.equal(checkInstallDate("2027-10-16", "2026-10-14"), "too_far_ahead");
  for (const bad of ["", "2026-02-30", "10/20/2026", "2026-1-5", "tomorrow"]) assert.equal(checkInstallDate(bad, "2026-10-14"), "invalid", bad);
});

// ---------- world ----------
const item = (id: string, productId: string, description: string, quantity: number, color: string | null = null) => ({
  id, kind: "material" as const, sortOrder: 0, productId, description, quantity, unitCostCents: 1000, unitPriceCents: 1667, color,
});
const labor = { id: "lab", kind: "labor" as const, sortOrder: 9, productId: null, description: "Install labor", quantity: 1, unitCostCents: 90_000, unitPriceCents: 150_000, color: null };
const scopeFor = (division: Division, items: StoredScope["items"]): StoredScope & { jobId: string } => ({
  id: `s-${division}`, jobId: "j1", selected: true, division, tier: "good", title: `Good ${division}`, targetMarginBps: 4000,
  costCents: 600_000, saleCents: 1_000_000, marginBps: 4000, items,
});

function world(over: Partial<ProductionJob> = {}) {
  const s = new MemoryProductionStore();
  s.jobs.push({
    id: "j1", jobNumber: 21, stage: "deposit_collected", estimatorId: "est1", divisions: ["roofing", "siding"], customerName: "Dana Miller",
    propertyAddress: "77 Two Trades Ln, West Plains, MO 65775", contractSigned: true, depositRequiredCents: 300_000, depositPaidCents: 300_000,
    materialsOrderedAt: null, poReference: null, ...over,
  });
  s.pm.set("pm-roof", ["roofing"]); s.pm.set("pm-side", ["siding"]);
  s.crew = [{ id: "crew1", fullName: "Crew One" }, { id: "crew2", fullName: "Crew Two" }];
  s.products = [
    { id: "p-shingle", name: "Shingles", unit: "sq", specialOrder: false },
    { id: "p-vinyl", name: "Vinyl siding", unit: "sq", specialOrder: true },
  ];
  s.chosen = [
    scopeFor("roofing", [item("r1", "p-shingle", "Shingles", 20, "Weathered Wood"), item("r2", "p-shingle", "Shingles", 5, "Weathered Wood"), item("r3", "p-shingle", "Shingles", 3), labor]),
    scopeFor("siding", [item("s1", "p-vinyl", "Vinyl siding", 24, "Clay")]),
  ];
  return s;
}
const order = (s: MemoryProductionStore, actor: Actor = EST1) => recordMaterialsOrder(s, { actor, jobId: "j1", poReference: "PO-1001" }, NOW);
const propose = (s: MemoryProductionStore, division: string, date: string, actor: Actor = EST1) => proposeInstall(s, { actor, jobId: "j1", division, installDate: date }, NOW);
const confirm = (s: MemoryProductionStore, division: string, crewLeaderId: string | null, actor: Actor, installDate?: string) =>
  confirmInstall(s, { actor, jobId: "j1", division, crewLeaderId, installDate }, NOW);
const stage = (s: MemoryProductionStore) => s.jobs[0].stage;

// ---------- rights ----------
test("rights: deposit gate needs a signed contract and a covered deposit (or none required)", () => {
  assert.equal(depositGateMet({ contractSigned: true, depositRequiredCents: 300_000, depositPaidCents: 300_000 }), true);
  assert.equal(depositGateMet({ contractSigned: true, depositRequiredCents: 300_000, depositPaidCents: 299_999 }), false);
  assert.equal(depositGateMet({ contractSigned: true, depositRequiredCents: 0, depositPaidCents: 0 }), true);
  assert.equal(depositGateMet({ contractSigned: false, depositRequiredCents: 0, depositPaidCents: 0 }), false);
});

test("rights: who can do what to a trade", () => {
  const job = world().jobs[0];
  const trade = (status: TradeStatus, crewLeaderId: string | null = null) => ({ division: "roofing" as Division, status, crewLeaderId });
  const ordered = { ...job, materialsOrderedAt: new Date() };
  // estimator proposes; cannot confirm, start or complete
  const e = tradeRights(EST1, job, trade("not_scheduled"), []);
  assert.deepEqual([e.canView, e.canPropose, e.canConfirm, e.canStart, e.canComplete], [true, true, false, false, false]);
  // once the PM has confirmed, the estimator can no longer change the date
  assert.equal(tradeRights(EST1, ordered, trade("scheduled", "crew1"), []).canPropose, false);
  // another estimator sees and does nothing
  assert.deepEqual(Object.values(tradeRights(EST2, job, trade("not_scheduled"), [])), [false, false, false, false, false]);
  // the trade's PM confirms (only after the order), starts and completes
  assert.equal(tradeRights(PM_ROOF, job, trade("proposed"), ["roofing"]).canConfirm, false);          // materials not ordered
  assert.equal(tradeRights(PM_ROOF, ordered, trade("proposed"), ["roofing"]).canConfirm, true);
  assert.equal(tradeRights(PM_ROOF, ordered, trade("scheduled", "crew1"), ["roofing"]).canStart, true);
  assert.equal(tradeRights(PM_ROOF, ordered, trade("in_production", "crew1"), ["roofing"]).canComplete, true);
  // the PM of a different trade can do none of it
  assert.deepEqual(Object.values(tradeRights(PM_SIDE, ordered, trade("proposed"), ["siding"])), [false, false, false, false, false]);
  // crew leader: only their own assigned trade, only once scheduled
  assert.equal(tradeRights(CREW1, ordered, trade("proposed", "crew1"), []).canView, false);
  const c = tradeRights(CREW1, ordered, trade("scheduled", "crew1"), []);
  assert.deepEqual([c.canView, c.canPropose, c.canConfirm, c.canStart, c.canComplete], [true, false, false, true, false]);
  assert.equal(tradeRights(CREW2, ordered, trade("scheduled", "crew1"), []).canView, false);
  // csr and accounting have no production rights
  assert.deepEqual(Object.values(tradeRights(CSR, job, trade("not_scheduled"), [])), [false, false, false, false, false]);
  assert.deepEqual(Object.values(tradeRights({ id: "a", role: "accounting" }, job, trade("not_scheduled"), [])), [false, false, false, false, false]);
  // admin can reschedule right up until the trade starts, not after
  assert.equal(tradeRights(ADMIN, ordered, trade("scheduled", "crew1"), []).canPropose, true);
  assert.equal(tradeRights(ADMIN, ordered, trade("in_production", "crew1"), []).canPropose, false);
  assert.equal(tradeRights(ADMIN, ordered, trade("in_production", "crew1"), []).canConfirm, false);
});

test("rights: closed jobs offer nothing", () => {
  const closed = { ...world().jobs[0], stage: "lost" as const, materialsOrderedAt: new Date() };
  assert.deepEqual(Object.values(tradeRights(ADMIN, closed, { division: "roofing", status: "scheduled", crewLeaderId: "crew1" }, [])).slice(1), [false, false, false, false]);
  assert.deepEqual(jobRights(ADMIN, closed, []), { canViewAll: true, canOrderMaterials: false, canEditSelections: false });
});

// ---------- materials ----------
test("materials: grouped by product and color, labor left out, quantities added", () => {
  const s = world();
  const list = buildMaterialList(s.chosen, s.products);
  const roofing = list.sections.find((x) => x.division === "roofing")!;
  assert.deepEqual(roofing.lines.map((l) => [l.description, l.color, l.quantity, l.unit]), [["Shingles", null, 3, "sq"], ["Shingles", "Weathered Wood", 25, "sq"]]);
  assert.ok(!roofing.lines.some((l) => l.description === "Install labor"));
  const siding = list.sections.find((x) => x.division === "siding")!;
  assert.deepEqual(siding.lines.map((l) => [l.description, l.color, l.quantity, l.specialOrder]), [["Vinyl siding", "Clay", 24, true]]);
  assert.equal(list.missingColors, 1);                       // the 3 squares with no color yet
});

test("materials: carries no price, cost or margin field anywhere", () => {
  const s = world();
  const json = JSON.stringify(buildMaterialList(s.chosen, s.products));
  assert.ok(!/price|cost|margin|cents|sale/i.test(json), json);
  const table = materialTable(buildMaterialList(s.chosen, s.products), (d) => d);
  assert.ok(table.columns.every((c) => c.kind !== "money"));
});

test("materials: limited to the trades asked for; CSV neutralises spreadsheet formulas", () => {
  const s = world();
  s.chosen[1].items[0].color = "=HYPERLINK(\"http://evil\")";
  const only = buildMaterialList(s.chosen, s.products, ["siding"]);
  assert.deepEqual(only.sections.map((x) => x.division), ["siding"]);
  const csv = toCsv(materialTable(only, (d) => d));
  assert.match(csv, /'=HYPERLINK/);
  assert.ok(csv.startsWith("Trade,Item,Color,Quantity,Unit,Special order"));
});

// ---------- gates ----------
test("gates: unsigned contract, uncovered deposit and closed jobs block ordering and proposing", async () => {
  const unsigned = world({ contractSigned: false });
  assert.equal(await code(order(unsigned)), "no_signed_contract");
  assert.equal(await code(propose(unsigned, "roofing", "2026-10-20")), "no_signed_contract");
  const unpaid = world({ depositPaidCents: 100_000 });
  assert.equal(await code(order(unpaid)), "deposit_not_covered");
  assert.equal(await code(propose(unpaid, "roofing", "2026-10-20")), "deposit_not_covered");
  const closed = world({ stage: "lost" });
  assert.equal(await code(order(closed)), "closed");
  const noDeposit = world({ depositRequiredCents: 0, depositPaidCents: 0, stage: "contract_signed" });
  await order(noDeposit);                                     // no deposit required: allowed
  assert.equal(stage(noDeposit), "materials_ordered");
});

// ---------- the materials order ----------
test("order: staff only, needs a PO number, once only; moves the job to Materials ordered", async () => {
  const s = world();
  for (const who of [EST2, PM_ROOF, CREW1, CSR]) assert.equal(await code(order(s, who)), "forbidden", who.role);
  assert.equal(await code(recordMaterialsOrder(s, { actor: EST1, jobId: "j1", poReference: "   " }, NOW)), "po_required");
  assert.equal(await code(recordMaterialsOrder(s, { actor: EST1, jobId: "j1", poReference: "x".repeat(61) }, NOW)), "po_required");
  assert.equal(stage(s), "deposit_collected");
  await order(s);
  assert.equal(stage(s), "materials_ordered");
  assert.equal(s.jobs[0].poReference, "PO-1001");
  assert.deepEqual(s.history.map((h) => [h.from, h.to]), [["deposit_collected", "materials_ordered"]]);
  assert.equal(await code(order(s, ADMIN)), "already_ordered");
  assert.equal(await code(recordMaterialsOrder(s, { actor: EST1, jobId: "nope", poReference: "PO" }, NOW)), "not_found");
});

// ---------- selections (colors) ----------
test("selections: only lines on the chosen packages, only before the order, never touches prices", async () => {
  const s = world();
  await saveSelections(s, { actor: EST1, jobId: "j1", items: [{ itemId: "r3", color: "  Charcoal " }, { itemId: "s1", color: null }] });
  assert.equal(s.chosen[0].items.find((i) => i.id === "r3")!.color, "Charcoal");
  assert.equal(s.chosen[1].items[0].color, null);              // cleared
  assert.equal(s.chosen[0].items.find((i) => i.id === "r1")!.unitPriceCents, 1667);   // prices unchanged
  assert.equal(await code(saveSelections(s, { actor: EST1, jobId: "j1", items: [{ itemId: "lab", color: "Red" }] })), "selection_invalid");      // labor line
  assert.equal(await code(saveSelections(s, { actor: EST1, jobId: "j1", items: [{ itemId: "nope", color: "Red" }] })), "selection_invalid");
  assert.equal(await code(saveSelections(s, { actor: EST1, jobId: "j1", items: [{ itemId: "r1", color: "x".repeat(61) }] })), "selection_invalid");
  assert.equal(await code(saveSelections(s, { actor: EST2, jobId: "j1", items: [{ itemId: "r1", color: "Red" }] })), "forbidden");
  assert.equal(await code(saveSelections(s, { actor: PM_ROOF, jobId: "j1", items: [{ itemId: "r1", color: "Red" }] })), "forbidden");
  await order(s);
  assert.equal(await code(saveSelections(s, { actor: EST1, jobId: "j1", items: [{ itemId: "r1", color: "Red" }] })), "selections_locked");
});

test("selections: a bad line in the batch saves nothing", async () => {
  const s = world();
  await assert.rejects(() => saveSelections(s, { actor: EST1, jobId: "j1", items: [{ itemId: "r3", color: "Charcoal" }, { itemId: "nope", color: "Red" }] }));
  assert.equal(s.chosen[0].items.find((i) => i.id === "r3")!.color, null);
});

test("selections: colors can be entered as soon as the contract is signed, before the deposit; ordering still waits for it", async () => {
  const s = world({ depositPaidCents: 0, stage: "contract_signed" });
  assert.deepEqual(jobRights(EST1, s.jobs[0], []), { canViewAll: true, canOrderMaterials: false, canEditSelections: true });
  await saveSelections(s, { actor: EST1, jobId: "j1", items: [{ itemId: "r3", color: "Charcoal" }] });
  assert.equal(s.chosen[0].items.find((i) => i.id === "r3")!.color, "Charcoal");
  assert.equal(await code(order(s, EST1)), "deposit_not_covered");                         // the order itself is still gated
  assert.equal(await code(saveSelections(s, { actor: EST2, jobId: "j1", items: [{ itemId: "r3", color: "Red" }] })), "forbidden");     // and still only the job's estimator
  assert.equal(await code(saveSelections(s, { actor: PM_ROOF, jobId: "j1", items: [{ itemId: "r3", color: "Red" }] })), "forbidden");
});

test("selections: not before the contract is signed, never on a closed job", async () => {
  const unsigned = world({ contractSigned: false });
  assert.equal(jobRights(EST1, unsigned.jobs[0], []).canEditSelections, false);
  assert.equal(await code(saveSelections(unsigned, { actor: EST1, jobId: "j1", items: [{ itemId: "r3", color: "Red" }] })), "no_signed_contract");
  const lost = world({ stage: "lost" });
  assert.equal(await code(saveSelections(lost, { actor: EST1, jobId: "j1", items: [{ itemId: "r3", color: "Red" }] })), "closed");
});

// ---------- propose ----------
test("propose: the job's own estimator or admin; sets the date and keeps the job's install date at the earliest", async () => {
  const s = world();
  const t = await propose(s, "roofing", "2026-10-22");
  assert.deepEqual([t.status, t.installDate, t.proposedBy], ["proposed", "2026-10-22", "est1"]);
  assert.equal(s.installDates.get("j1"), "2026-10-22");
  await propose(s, "siding", "2026-10-20");
  assert.equal(s.installDates.get("j1"), "2026-10-20");        // earliest trade date
  await propose(s, "siding", "2026-10-26", ADMIN);
  assert.equal(s.installDates.get("j1"), "2026-10-22");
  for (const who of [EST2, PM_ROOF, CREW1, CSR]) assert.equal(await code(propose(s, "roofing", "2026-10-25", who)), "forbidden", who.role);
  assert.equal(stage(s), "deposit_collected");                 // proposing alone doesn't move the stage
});

test("propose: bad dates and trades are refused", async () => {
  const s = world();
  assert.equal(await code(propose(s, "roofing", "2026-10-13")), "date_in_past");
  assert.equal(await code(propose(s, "roofing", "2026-02-30")), "date_invalid");
  assert.equal(await code(propose(s, "roofing", "2028-01-01")), "date_too_far");
  assert.equal(await code(propose(s, "gutters", "2026-10-20")), "division_not_on_job");
  assert.equal(await code(propose(s, "solar", "2026-10-20")), "division_not_on_job");
  assert.equal(await code(proposeInstall(s, { actor: EST1, jobId: "nope", division: "roofing", installDate: "2026-10-20" }, NOW)), "not_found");
  assert.equal(s.trades.length, 0);
});

// ---------- confirm ----------
test("confirm: needs the order first; the trade's PM or admin only; the crew leader must be real", async () => {
  const s = world();
  await propose(s, "roofing", "2026-10-22");
  assert.equal(await code(confirm(s, "roofing", "crew1", PM_ROOF)), "materials_not_ordered");
  await order(s);
  assert.equal(await code(confirm(s, "roofing", "crew1", PM_SIDE)), "forbidden");        // the other trade's PM
  assert.equal(await code(confirm(s, "roofing", "crew1", EST1)), "forbidden");           // estimators propose only
  assert.equal(await code(confirm(s, "roofing", "crew1", CREW1)), "forbidden");
  assert.equal(await code(confirm(s, "roofing", null, PM_ROOF)), "crew_required");
  assert.equal(await code(confirm(s, "roofing", "someone-else", PM_ROOF)), "crew_invalid");
  const { trade } = await confirm(s, "roofing", "crew1", PM_ROOF);
  assert.deepEqual([trade.status, trade.installDate, trade.crewLeaderId, trade.confirmedBy], ["scheduled", "2026-10-22", "crew1", "pm-roof"]);
});

test("confirm: a PM can set the date themselves; a missing or past date is refused", async () => {
  const s = world();
  await order(s);
  assert.equal(await code(confirm(s, "siding", "crew2", PM_SIDE)), "date_required");     // nothing proposed, none given
  assert.equal(await code(confirm(s, "siding", "crew2", PM_SIDE, "2026-10-01")), "date_in_past");
  const { trade } = await confirm(s, "siding", "crew2", PM_SIDE, "2026-10-27");
  assert.deepEqual([trade.status, trade.installDate], ["scheduled", "2026-10-27"]);
});

test("confirm: the job becomes Scheduled only when every trade is confirmed", async () => {
  const s = world();
  await propose(s, "roofing", "2026-10-22"); await propose(s, "siding", "2026-10-23");
  await order(s);
  assert.equal(stage(s), "materials_ordered");
  await confirm(s, "roofing", "crew1", PM_ROOF);
  assert.equal(stage(s), "materials_ordered");                 // siding still unconfirmed
  await confirm(s, "siding", "crew2", PM_SIDE);
  assert.equal(stage(s), "scheduled");
});

test("confirm: a crew leader booked twice on one day is a warning, not a block", async () => {
  const s = world();
  await propose(s, "roofing", "2026-10-22"); await propose(s, "siding", "2026-10-22");
  await order(s);
  assert.deepEqual((await confirm(s, "roofing", "crew1", PM_ROOF)).conflicts, []);
  const second = await confirm(s, "siding", "crew1", PM_SIDE);                          // same crew, same day
  assert.deepEqual(second.conflicts, [{ jobNumber: 21, division: "roofing" }]);
  assert.equal(second.trade.status, "scheduled");
});

test("confirm: rescheduling is fine until the trade starts, then locked", async () => {
  const s = world();
  await propose(s, "roofing", "2026-10-22"); await order(s);
  await confirm(s, "roofing", "crew1", PM_ROOF);
  const moved = await confirm(s, "roofing", "crew2", PM_ROOF, "2026-10-29");
  assert.deepEqual([moved.trade.installDate, moved.trade.crewLeaderId], ["2026-10-29", "crew2"]);
  await startTrade(s, { actor: CREW2, jobId: "j1", division: "roofing" }, NOW);
  assert.equal(await code(confirm(s, "roofing", "crew1", PM_ROOF, "2026-11-02")), "bad_status");
  assert.equal(await code(propose(s, "roofing", "2026-11-02", ADMIN)), "bad_status");
});

// ---------- start and complete ----------
async function scheduledBoth(s: MemoryProductionStore) {
  await propose(s, "roofing", "2026-10-22"); await propose(s, "siding", "2026-10-23");
  await order(s);
  await confirm(s, "roofing", "crew1", PM_ROOF); await confirm(s, "siding", "crew2", PM_SIDE);
}

test("production: the assigned crew leader starts and completes; the job follows the trades", async () => {
  const s = world();
  await scheduledBoth(s);
  assert.equal(stage(s), "scheduled");
  const started = await startTrade(s, { actor: CREW1, jobId: "j1", division: "roofing" }, NOW);
  assert.deepEqual([started.status, started.startedAt?.toISOString()], ["in_production", "2026-10-14T17:00:00.000Z"]);
  assert.equal(stage(s), "in_production");
  await completeTrade(s, { actor: CREW1, jobId: "j1", division: "roofing" }, NOW);
  assert.equal(stage(s), "in_production");                     // siding still to do
  await startTrade(s, { actor: CREW2, jobId: "j1", division: "siding" }, NOW);
  await completeTrade(s, { actor: PM_SIDE, jobId: "j1", division: "siding" }, NOW);   // the PM can finish it too
  assert.equal(stage(s), "closeout_punchlist");
  assert.deepEqual(s.history.map((h) => h.to), ["materials_ordered", "scheduled", "in_production", "closeout_punchlist"]);
});

test("production: unassigned crew leaders, wrong PMs and wrong order of steps are refused", async () => {
  const s = world();
  await scheduledBoth(s);
  assert.equal(await code(startTrade(s, { actor: CREW2, jobId: "j1", division: "roofing" }, NOW)), "forbidden");   // crew2 is on siding
  assert.equal(await code(startTrade(s, { actor: PM_SIDE, jobId: "j1", division: "roofing" }, NOW)), "forbidden");
  assert.equal(await code(startTrade(s, { actor: EST1, jobId: "j1", division: "roofing" }, NOW)), "forbidden");
  assert.equal(await code(completeTrade(s, { actor: CREW1, jobId: "j1", division: "roofing" }, NOW)), "bad_status"); // not started
  await startTrade(s, { actor: CREW1, jobId: "j1", division: "roofing" }, NOW);
  assert.equal(await code(startTrade(s, { actor: CREW1, jobId: "j1", division: "roofing" }, NOW)), "bad_status");    // already started
  await completeTrade(s, { actor: CREW1, jobId: "j1", division: "roofing" }, NOW);
  assert.equal(await code(completeTrade(s, { actor: CREW1, jobId: "j1", division: "roofing" }, NOW)), "bad_status"); // already complete
});

test("production: every action is written to the event log with who did it", async () => {
  const s = world();
  await scheduledBoth(s);
  await startTrade(s, { actor: CREW1, jobId: "j1", division: "roofing" }, NOW);
  assert.deepEqual(s.events.map((e) => [e.action, e.actorId]), [
    ["propose", "est1"], ["propose", "est1"], ["materials_ordered", "est1"], ["confirm", "pm-roof"], ["confirm", "pm-side"], ["start", "crew1"],
  ]);
});

test("production: a failure partway leaves nothing half done", async () => {
  const s = world();
  await propose(s, "roofing", "2026-10-22"); await order(s);
  const real = s.transaction.bind(s);
  s.transaction = (async (id: string, fn: Parameters<typeof real>[1]) => real(id, async (tx) => fn({
    ...tx, logEvent: async () => { throw new Error("db hiccup"); },
  }))) as typeof s.transaction;
  await assert.rejects(() => confirm(s, "roofing", "crew1", PM_ROOF), /db hiccup/);
  assert.equal(s.trades.find((t) => t.division === "roofing")?.status, "proposed");
  assert.equal(stage(s), "materials_ordered");
});

// ---------- what each person sees ----------
test("view: estimator sees everything; crew leader sees only their trade, the address, and no customer name or prices", async () => {
  const s = world();
  await scheduledBoth(s);
  const est = await productionView(s, EST1, "j1");
  assert.deepEqual(est.trades.map((t) => t.division), ["roofing", "siding"]);
  assert.equal(est.job.customerName, "Dana Miller");
  assert.equal(est.materials?.sections.length, 2);
  assert.ok(est.selectionLines.length > 0);

  const crew = await productionView(s, CREW1, "j1");
  assert.deepEqual(crew.trades.map((t) => t.division), ["roofing"]);
  assert.equal(crew.job.customerName, null);
  assert.equal(crew.job.propertyAddress, "77 Two Trades Ln, West Plains, MO 65775");
  assert.deepEqual(crew.materials?.sections.map((x) => x.division), ["roofing"]);
  assert.deepEqual(crew.selectionLines, []);
  assert.ok(!/price|cost|margin|cents|phone/i.test(JSON.stringify(crew)), JSON.stringify(crew));
  assert.equal(crew.trades[0].rights.canStart, true);
});

test("view: a PM sees only the trades they manage, with the crew list to choose from", async () => {
  const s = world();
  await propose(s, "roofing", "2026-10-22"); await order(s);
  const pm = await productionView(s, PM_SIDE, "j1");
  assert.deepEqual(pm.trades.map((t) => t.division), ["siding"]);
  assert.deepEqual(pm.materials?.sections.map((x) => x.division), ["siding"]);
  assert.deepEqual(pm.crewLeaders.map((c) => c.id), ["crew1", "crew2"]);
  assert.deepEqual(pm.selectionLines, []);
});

test("view: other estimators, CSRs, unassigned crew leaders and PMs of other trades see nothing", async () => {
  const s = world();
  await scheduledBoth(s);
  for (const who of [EST2, CSR, { id: "crew3", role: "crew_leader" as const }, { id: "pm-gutters", role: "production_manager" as const }, { id: "a", role: "accounting" as const }]) {
    assert.equal(await code(productionView(s, who, "j1")), "forbidden", who.role);
  }
  assert.equal(await code(productionView(s, EST1, "nope")), "not_found");
  assert.equal(mergeTrades(["roofing", "siding"], []).every((t) => t.status === "not_scheduled"), true);
});

test("view: a crew leader sees a trade only once it is scheduled", async () => {
  const s = world();
  await propose(s, "roofing", "2026-10-22"); await order(s);
  s.trades.find((t) => t.division === "roofing")!.crewLeaderId = "crew1";                  // assigned but still only proposed
  assert.equal(await code(productionView(s, CREW1, "j1")), "forbidden");
  await confirm(s, "roofing", "crew1", PM_ROOF);
  assert.equal((await productionView(s, CREW1, "j1")).trades.length, 1);
});

// ---------- the board ----------
test("board: each role sees only its own work; crew leaders get no queues and no customer name", async () => {
  const s = world();
  s.jobs.push({ ...s.jobs[0], id: "j2", jobNumber: 22, estimatorId: "est2", divisions: ["roofing"], customerName: "Other Person", propertyAddress: "9 Elsewhere Rd" });
  await scheduledBoth(s);
  const range = { from: "2026-10-19", to: "2026-10-25" };

  const admin = await scheduleBoard(s, ADMIN, range);
  assert.deepEqual(admin.items.map((i) => `${i.jobNumber}:${i.division}`).sort(), ["21:roofing", "21:siding"]);
  assert.ok(admin.needsDate.some((i) => i.jobNumber === 22));           // job 2 has nothing proposed yet

  const e1 = await scheduleBoard(s, EST1, range);
  assert.deepEqual(e1.items.map((i) => i.jobNumber), [21, 21]);
  assert.ok(e1.needsDate.every((i) => i.jobNumber === 21) && e1.needsCrew.every((i) => i.jobNumber === 21));

  const pm = await scheduleBoard(s, PM_SIDE, range);
  assert.deepEqual(pm.items.map((i) => i.division), ["siding"]);

  const crew = await scheduleBoard(s, CREW1, range);
  assert.deepEqual(crew.items.map((i) => `${i.jobNumber}:${i.division}`), ["21:roofing"]);
  assert.deepEqual([crew.needsDate, crew.needsCrew], [[], []]);
  assert.ok(crew.items.every((i) => i.customerName === null));

  assert.equal(await code(scheduleBoard(s, CSR, range)), "forbidden");
  assert.equal(await code(scheduleBoard(s, { id: "a", role: "accounting" }, range)), "forbidden");
});

test("board: date range and filters apply", async () => {
  const s = world();
  await scheduledBoth(s);
  assert.equal((await scheduleBoard(s, ADMIN, { from: "2026-10-23", to: "2026-10-23" })).items.length, 1);   // only the siding day
  assert.equal((await scheduleBoard(s, ADMIN, { from: "2026-11-01", to: "2026-11-07" })).items.length, 0);
  assert.deepEqual((await scheduleBoard(s, ADMIN, { from: "2026-10-19", to: "2026-10-25" }, { division: "roofing" })).items.map((i) => i.division), ["roofing"]);
  assert.deepEqual((await scheduleBoard(s, ADMIN, { from: "2026-10-19", to: "2026-10-25" }, { crewLeaderId: "crew2" })).items.map((i) => i.division), ["siding"]);
});

test("board: the needs-a-crew queue lists proposed trades; confirmed ones leave it", async () => {
  const s = world();
  await propose(s, "roofing", "2026-10-22"); await order(s);
  const before = await scheduleBoard(s, PM_ROOF, { from: "2026-10-19", to: "2026-10-25" });
  assert.deepEqual(before.needsCrew.map((i) => i.division), ["roofing"]);
  await confirm(s, "roofing", "crew1", PM_ROOF);
  const after = await scheduleBoard(s, PM_ROOF, { from: "2026-10-19", to: "2026-10-25" });
  assert.deepEqual(after.needsCrew, []);
});
