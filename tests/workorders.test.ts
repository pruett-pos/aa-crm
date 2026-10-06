import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import {
  WorkOrderError, addTask, createWorkOrders, createWorkOrdersFor, issueWorkOrder, onContractSigned, removeTask, reopenWorkOrder, setTaskNote,
  setWorkOrderNotes, workOrderPdfData, workOrdersView, type SigningMailer,
} from "../src/lib/workorders/logic.ts";
import { MemoryWorkOrderStore } from "../src/lib/workorders/memory-store.ts";
import { renderWorkOrderPdf, workOrderText } from "../src/lib/workorders/pdf.ts";
import { canManageWorkOrders, canReopen, canViewWorkOrder } from "../src/lib/workorders/rights.ts";
import type { Actor } from "../src/lib/production/types.ts";

const adm: Actor = { id: "adm", role: "admin" };
const est1: Actor = { id: "est1", role: "estimator" };
const est2: Actor = { id: "est2", role: "estimator" };
const pmRoof: Actor = { id: "pmr", role: "production_manager" };
const pmSide: Actor = { id: "pms", role: "production_manager" };
const pmGutter: Actor = { id: "pmg", role: "production_manager" };
const crew1: Actor = { id: "crew1", role: "crew_leader" };     // roofing
const crew2: Actor = { id: "crew2", role: "crew_leader" };     // siding
const crew3: Actor = { id: "crew3", role: "crew_leader" };     // nothing on this job
const csr: Actor = { id: "csr", role: "csr" };
const acct: Actor = { id: "acct", role: "accounting" };

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof WorkOrderError ? e.code : `other:${String(e)}`));

/** A two-trade signed job: roofing and siding, each with labor lines and materials still without colors. */
function setup(over: Partial<Parameters<MemoryWorkOrderStore["addJob"]>[0]> = {}) {
  const s = new MemoryWorkOrderStore();
  const job = s.addJob({ divisions: ["roofing", "siding"], ...over });
  s.trades.set(job.id, [
    { division: "roofing", status: "scheduled", installDate: "2026-10-20", crewLeaderId: "crew1", crewLeaderName: "Crew One" },
    { division: "siding", status: "proposed", installDate: "2026-10-27", crewLeaderId: "crew2", crewLeaderName: "Crew Two" },
  ]);
  s.pm.set("pmr", ["roofing"]); s.pm.set("pms", ["siding"]); s.pm.set("pmg", ["gutters"]);
  s.setSource(job.id, "roofing", [
    { itemId: "r-tear", description: "Tear off existing roof", quantity: 24.37, unit: "sq" },
    { itemId: "r-inst", description: "Install shingles", quantity: 24.37, unit: "sq" },
    { itemId: "r-dump", description: "Dumpster", quantity: 1, unit: "ea" },
  ]);
  s.setSource(job.id, "siding", [{ itemId: "s-inst", description: "Install siding", quantity: 18, unit: "sq" }]);
  s.setMaterials(job.id, "roofing", [
    { itemId: "m1", description: "Architectural shingles", unit: "sq", quantity: 27, color: null },
    { itemId: "m2", description: "Starter strip", unit: "bundle", quantity: 3, color: null },
  ]);
  s.setMaterials(job.id, "siding", [{ itemId: "m3", description: "Vinyl siding", unit: "sq", quantity: 18, color: null }]);
  s.estimators.set("est1", { email: "est1@example.com", name: "Estimator One" });
  return { s, job };
}
const color = (s: MemoryWorkOrderStore, jobId: string) => {
  s.setColor(jobId, "roofing", "m1", "Charcoal"); s.setColor(jobId, "roofing", "m2", "Black"); s.setColor(jobId, "siding", "m3", "Sand");
};

// ---------- drafts ----------
test("create: a draft per trade from the signed package's labor lines; quantities and units only", async () => {
  const { s, job } = setup();
  assert.deepEqual((await createWorkOrders(s, job.id, null)).created, ["roofing", "siding"]);
  const roofing = s.orders.find((o) => o.division === "roofing")!;
  assert.deepEqual([roofing.status, roofing.notes, roofing.issuedAt, roofing.createdBy], ["draft", null, null, null]);
  assert.deepEqual(roofing.lines.map((l) => [l.description, l.quantity, l.unit, l.sourceItemId, l.note]), [
    ["Tear off existing roof", 24.37, "sq", "r-tear", null], ["Install shingles", 24.37, "sq", "r-inst", null], ["Dumpster", 1, "ea", "r-dump", null],
  ]);
  assert.equal(s.orders.length, 2);
});

test("create: safe to run again; a trade that already has one is left alone, a late-added trade gets its own", async () => {
  const { s, job } = setup();
  await createWorkOrders(s, job.id, null);
  const first = s.orders.map((o) => o.id);
  assert.deepEqual((await createWorkOrders(s, job.id, null)).created, []);
  assert.deepEqual(s.orders.map((o) => o.id), first);
  await setWorkOrderNotes(s, est1, job.id, "roofing", "Mind the dog");
  await createWorkOrders(s, job.id, null);
  assert.equal(s.orders.find((o) => o.division === "roofing")!.notes, "Mind the dog");        // not overwritten
  const late = setup(); late.s.setSource(late.job.id, "siding", []);
  assert.deepEqual((await createWorkOrders(late.s, late.job.id, null)).created, ["roofing"]);   // no labor lines: no work order
  late.s.setSource(late.job.id, "siding", [{ itemId: "x", description: "Install siding", quantity: 5, unit: "sq" }]);
  assert.deepEqual((await createWorkOrders(late.s, late.job.id, null)).created, ["siding"]);
});

test("create: two at once make exactly one per trade", async () => {
  const { s, job } = setup();
  const results = await Promise.all([createWorkOrders(s, job.id, null), createWorkOrders(s, job.id, "adm"), createWorkOrders(s, job.id, null)]);
  assert.equal(s.orders.length, 2);
  assert.equal(results.flatMap((r) => r.created).length, 2);
});

test("create: needs a signed contract on an open job; unknown jobs are not found", async () => {
  const unsigned = setup({ contractSigned: false });
  assert.equal(await code(createWorkOrders(unsigned.s, unsigned.job.id, null)), "no_signed_contract");
  for (const stage of ["lost", "cancelled_after_approval"] as const) {
    const closed = setup({ stage });
    assert.equal(await code(createWorkOrders(closed.s, closed.job.id, null)), "closed", stage);
  }
  assert.equal(await code(createWorkOrders(setup().s, "nope", null)), "not_found");
  assert.equal(unsigned.s.orders.length, 0);
});

test("create by hand: admin and the job's estimator only", async () => {
  const { s, job } = setup();
  for (const who of [est2, pmRoof, crew1, csr, acct]) assert.equal(await code(createWorkOrdersFor(s, who, job.id)), "forbidden", who.id);
  assert.equal(s.orders.length, 0);
  assert.equal(await code(createWorkOrdersFor(s, est1, job.id)), "ok");
  assert.equal(await code(createWorkOrdersFor(s, adm, "nope")), "not_found");
});

test("no money anywhere on a work order", async () => {
  const { s, job } = setup();
  await createWorkOrders(s, job.id, null);
  const json = JSON.stringify([s.orders, await workOrdersView(s, adm, job.id)]);
  assert.ok(!/price|cost|rate|margin|commission|cents|\$/i.test(json));
});

// ---------- signing ----------
test("signing: drafts are made and the estimator is told how many colors are needed", async () => {
  const { s, job } = setup();
  s.needing = [{ jobId: job.id, missing: 3 }];
  const mails: Parameters<SigningMailer>[0][] = [];
  const r = await onContractSigned(s, async (m) => { mails.push(m); }, job.id);
  assert.deepEqual([r.created, r.emailed], [["roofing", "siding"], true]);
  assert.deepEqual(mails, [{ to: "est1@example.com", estimatorName: "Estimator One", jobNumber: 1, address: "100 Example Rd, West Plains, MO 65775", missing: 3 }]);
});

test("signing: nothing that goes wrong here can throw (the signature stands)", async () => {
  const unsigned = setup({ contractSigned: false });
  const r1 = await onContractSigned(unsigned.s, async () => { throw new Error("mail down"); }, unsigned.job.id);
  assert.deepEqual([r1.created, r1.emailed], [[], false]);
  const ok = setup();
  const r2 = await onContractSigned(ok.s, async () => { throw new Error("mail down"); }, ok.job.id);
  assert.deepEqual([r2.created, r2.emailed, ok.s.orders.length], [["roofing", "siding"], false, 2]);            // the work orders still exist
  const broken = setup();
  broken.s.transaction = async () => { throw new Error("db down"); };
  const r3 = await onContractSigned(broken.s, async () => undefined, broken.job.id);
  assert.deepEqual([r3.created, r3.emailed], [[], true]);                                                       // creation failed, the estimator is still told
  const noEstimator = setup({ estimatorId: null });
  assert.equal((await onContractSigned(noEstimator.s, async () => undefined, noEstimator.job.id)).emailed, false);
  assert.equal((await onContractSigned(setup().s, async () => undefined, "nope")).emailed, false);
});

// ---------- who sees what ----------
test("view: managers see drafts with what's missing; a PM sees only their trade; nobody else gets in", async () => {
  const { s, job } = setup();
  await createWorkOrders(s, job.id, null);
  for (const who of [adm, est1]) {
    const v = await workOrdersView(s, who, job.id);
    assert.deepEqual(v.orders.map((o) => [o.division, o.status, o.canEdit, o.canIssue, o.colorsMissing]), [["roofing", "draft", true, false, 2], ["siding", "draft", true, false, 1]]);
    assert.equal(v.canCreate, false);
  }
  const pr = await workOrdersView(s, pmRoof, job.id);
  assert.deepEqual(pr.orders.map((o) => [o.division, o.canEdit, o.canIssue, o.colorsMissing]), [["roofing", false, false, 0]]);
  assert.deepEqual((await workOrdersView(s, pmSide, job.id)).orders.map((o) => o.division), ["siding"]);
  for (const who of [est2, pmGutter, crew1, crew2, crew3, csr, acct]) assert.equal(await code(workOrdersView(s, who, job.id)), "forbidden", who.id);
  assert.equal(await code(workOrdersView(s, adm, "nope")), "not_found");
});

test("view: a PM with a trade but no work order yet sees an empty list; the creator sees what is missing", async () => {
  const { s, job } = setup();
  assert.deepEqual((await workOrdersView(s, pmRoof, job.id)).orders, []);
  const v = await workOrdersView(s, est1, job.id);
  assert.deepEqual([v.orders.length, v.canCreate, v.missingTrades], [0, true, ["roofing", "siding"]]);
  assert.deepEqual((await workOrdersView(s, pmRoof, job.id)).missingTrades, []);
});

test("crew: only an ISSUED order for their own CONFIRMED trade, never a draft, never another crew's, never the customer", async () => {
  const { s, job } = setup();
  await createWorkOrders(s, job.id, null);
  assert.equal(await code(workOrdersView(s, crew1, job.id)), "forbidden");                    // a draft is invisible to the crew
  color(s, job.id);
  await issueWorkOrder(s, est1, job.id, "roofing");
  const v = await workOrdersView(s, crew1, job.id);
  assert.deepEqual(v.orders.map((o) => [o.division, o.status, o.canEdit, o.canIssue, o.colorsMissing]), [["roofing", "issued", false, false, 0]]);
  assert.ok(!JSON.stringify(v).includes("Dana") && !/customer|phone|email/i.test(JSON.stringify(v)));
  assert.equal(await code(workOrdersView(s, crew2, job.id)), "forbidden");                    // siding is still a draft and its trade isn't confirmed
  assert.equal(await code(workOrdersView(s, crew3, job.id)), "forbidden");
  await issueWorkOrder(s, est1, job.id, "siding");
  assert.equal(await code(workOrdersView(s, crew2, job.id)), "forbidden");                    // issued, but the trade is only proposed
  s.trades.get(job.id)![1].status = "scheduled";
  assert.deepEqual((await workOrdersView(s, crew2, job.id)).orders.map((o) => o.division), ["siding"]);
  assert.deepEqual((await workOrdersView(s, crew1, job.id)).orders.map((o) => o.division), ["roofing"]);     // still only their own
});

test("rights helpers: manage, view and reopen", () => {
  const job = { estimatorId: "est1" };
  const trade = (status: "scheduled" | "proposed" | "in_production", crew = "crew1") => ({ division: "roofing" as const, status, crewLeaderId: crew });
  assert.ok(canManageWorkOrders(adm, job) && canManageWorkOrders(est1, job));
  for (const a of [est2, pmRoof, crew1, csr, acct]) assert.ok(!canManageWorkOrders(a, job), a.id);
  assert.ok(canViewWorkOrder(pmRoof, job, "draft", trade("proposed"), ["roofing"]) && !canViewWorkOrder(pmGutter, job, "draft", trade("proposed"), ["gutters"]));
  assert.ok(!canViewWorkOrder(crew1, job, "draft", trade("scheduled"), []) && canViewWorkOrder(crew1, job, "issued", trade("scheduled"), []));
  assert.ok(canViewWorkOrder(crew1, job, "issued", trade("in_production"), []) && !canViewWorkOrder(crew1, job, "issued", trade("proposed"), []));
  assert.ok(!canViewWorkOrder(crew3, job, "issued", trade("scheduled"), []));
  assert.ok(canReopen(adm, trade("scheduled")) && !canReopen(adm, trade("in_production")) && !canReopen(est1, trade("scheduled")));
});

// ---------- editing a draft ----------
test("notes: the estimator or admin; cleaned; empty clears; long ones refused", async () => {
  const { s, job } = setup();
  await createWorkOrders(s, job.id, null);
  await setWorkOrderNotes(s, est1, job.id, "roofing", "  Gate code\t1234\n  Dog   inside ");
  assert.equal(s.orders[0].notes, "Gate code 1234 Dog inside");
  await setWorkOrderNotes(s, adm, job.id, "roofing", "");
  assert.equal(s.orders[0].notes, null);
  assert.equal(await code(setWorkOrderNotes(s, est1, job.id, "roofing", "x".repeat(1001))), "text_invalid");
  for (const who of [est2, pmRoof, crew1, csr, acct]) assert.equal(await code(setWorkOrderNotes(s, who, job.id, "roofing", "hi")), "forbidden", who.id);
  assert.equal(await code(setWorkOrderNotes(s, est1, job.id, "gutters", "hi")), "division_not_on_job");
  assert.equal(await code(setWorkOrderNotes(s, est1, job.id, "roofing", { a: 1 })), "ok");              // not text: treated as nothing
});

test("tasks: add by hand with checks; notes on any task; only hand-added tasks can be removed", async () => {
  const { s, job } = setup();
  await createWorkOrders(s, job.id, null);
  await addTask(s, est1, job.id, "roofing", { description: "  Pull   permit ", quantity: "2.505", unit: " EA ", note: "City hall" });
  const added = s.orders[0].lines.at(-1)!;
  assert.deepEqual([added.description, added.quantity, added.unit, added.note, added.sourceItemId], ["Pull permit", 2.51, "ea", "City hall", null]);
  await addTask(s, adm, job.id, "roofing", { description: "Cover the deck", quantity: 1 });
  assert.equal(s.orders[0].lines.at(-1)!.unit, "ea");
  for (const bad of [0, -1, Number.NaN, 100_001, "", "abc", null, undefined]) assert.equal(await code(addTask(s, est1, job.id, "roofing", { description: "x", quantity: bad })), "quantity_invalid", String(bad));
  for (const bad of ["", "   ", "x".repeat(201), null, 5]) assert.equal(await code(addTask(s, est1, job.id, "roofing", { description: bad, quantity: 1 })), "text_invalid", String(bad));
  assert.equal(await code(addTask(s, est1, job.id, "roofing", { description: "x", quantity: 1, unit: "sq ft" })), "unit_invalid");
  assert.equal(await code(addTask(s, est1, job.id, "roofing", { description: "x", quantity: 1, note: "n".repeat(301) })), "text_invalid");
  for (const who of [est2, pmRoof, crew1, csr, acct]) assert.equal(await code(addTask(s, who, job.id, "roofing", { description: "x", quantity: 1 })), "forbidden", who.id);

  const fromScope = s.orders[0].lines[0], byHand = s.orders[0].lines.find((l) => l.sourceItemId === null)!;
  await setTaskNote(s, est1, job.id, "roofing", fromScope.id, "  Start at the back  ");
  assert.equal(fromScope.note, "Start at the back");
  await setTaskNote(s, est1, job.id, "roofing", fromScope.id, null);
  assert.equal(fromScope.note, null);
  assert.equal(await code(setTaskNote(s, est1, job.id, "roofing", "nope", "x")), "line_not_found");
  assert.equal(await code(removeTask(s, est1, job.id, "roofing", fromScope.id)), "not_a_hand_line");           // the signed scope's lines stay
  assert.equal(await code(removeTask(s, est1, job.id, "roofing", "nope")), "line_not_found");
  assert.equal(await code(removeTask(s, est1, job.id, "roofing", byHand.id)), "ok");
  assert.ok(!s.orders[0].lines.some((l) => l.id === byHand.id));
});

test("tasks: a work order holds at most 60", async () => {
  const { s, job } = setup();
  await createWorkOrders(s, job.id, null);
  while (s.orders[0].lines.length < 60) await addTask(s, est1, job.id, "roofing", { description: `task ${s.orders[0].lines.length}`, quantity: 1 });
  assert.equal(await code(addTask(s, est1, job.id, "roofing", { description: "one more", quantity: 1 })), "too_many_lines");
});

test("editing: no work order yet, a closed job, and a missing trade", async () => {
  const { s, job } = setup();
  assert.equal(await code(setWorkOrderNotes(s, est1, job.id, "roofing", "hi")), "no_work_order");
  await createWorkOrders(s, job.id, null);
  s.jobs[0].stage = "lost";
  assert.equal(await code(setWorkOrderNotes(s, est1, job.id, "roofing", "hi")), "closed");
  assert.equal(await code(setWorkOrderNotes(s, est1, "nope", "roofing", "hi")), "not_found");
});

// ---------- issue ----------
test("issue: blocked until every material line of that trade has a color, and says how many", async () => {
  const { s, job } = setup();
  await createWorkOrders(s, job.id, null);
  const err = await issueWorkOrder(s, est1, job.id, "roofing").catch((e: WorkOrderError) => e);
  assert.ok(err instanceof WorkOrderError && err.code === "colors_missing" && err.count === 2);
  s.setColor(job.id, "roofing", "m1", "Charcoal");
  assert.equal((await issueWorkOrder(s, est1, job.id, "roofing").catch((e: WorkOrderError) => e) as WorkOrderError).count, 1);
  s.setColor(job.id, "roofing", "m2", "   ");                                                       // blanks don't count
  assert.equal(await code(issueWorkOrder(s, est1, job.id, "roofing")), "colors_missing");
  s.setColor(job.id, "roofing", "m2", "Black");
  assert.equal(await code(issueWorkOrder(s, est1, job.id, "roofing")), "ok");
  assert.equal(s.orders.find((o) => o.division === "siding")!.status, "draft");                       // siding is separate: its colors are still missing
  assert.equal(await code(issueWorkOrder(s, est1, job.id, "siding")), "colors_missing");
});

test("issue: freezes it (no more edits), records who and when; a second issue is refused", async () => {
  const { s, job } = setup();
  await createWorkOrders(s, job.id, null);
  color(s, job.id);
  const at = new Date("2026-10-15T14:00:00Z");
  await issueWorkOrder(s, est1, job.id, "roofing", () => at);
  const o = s.orders.find((x) => x.division === "roofing")!;
  assert.deepEqual([o.status, o.issuedAt, o.issuedBy], ["issued", at, "est1"]);
  assert.equal(await code(issueWorkOrder(s, est1, job.id, "roofing")), "not_draft");
  assert.equal(await code(setWorkOrderNotes(s, est1, job.id, "roofing", "late note")), "not_draft");
  assert.equal(await code(addTask(s, est1, job.id, "roofing", { description: "x", quantity: 1 })), "not_draft");
  assert.equal(await code(removeTask(s, est1, job.id, "roofing", o.lines[0].id)), "not_draft");
  assert.equal(o.notes, null);
});

test("issue: only admin and the job's estimator; a trade with no tasks can't be issued", async () => {
  const { s, job } = setup();
  await createWorkOrders(s, job.id, null);
  color(s, job.id);
  for (const who of [est2, pmRoof, crew1, csr, acct]) assert.equal(await code(issueWorkOrder(s, who, job.id, "roofing")), "forbidden", who.id);
  assert.equal(s.orders[0].status, "draft");
  s.orders[0].lines.length = 0;
  assert.equal(await code(issueWorkOrder(s, est1, job.id, "roofing")), "no_work_order");
});

test("issue: colors are only needed once a trade has materials; a labor-only trade issues straight away", async () => {
  const { s, job } = setup();
  s.setMaterials(job.id, "siding", []);
  await createWorkOrders(s, job.id, null);
  assert.equal(await code(issueWorkOrder(s, est1, job.id, "siding")), "ok");
});

// ---------- reopen ----------
test("reopen: admin only, only an issued order, only before the crew starts", async () => {
  const { s, job } = setup();
  await createWorkOrders(s, job.id, null);
  color(s, job.id);
  assert.equal(await code(reopenWorkOrder(s, adm, job.id, "roofing")), "not_issued");
  await issueWorkOrder(s, est1, job.id, "roofing");
  for (const who of [est1, est2, pmRoof, crew1, csr, acct]) assert.equal(await code(reopenWorkOrder(s, who, job.id, "roofing")), "forbidden", who.id);
  s.trades.get(job.id)![0].status = "in_production";
  assert.equal(await code(reopenWorkOrder(s, adm, job.id, "roofing")), "trade_started");
  s.trades.get(job.id)![0].status = "scheduled";
  await reopenWorkOrder(s, adm, job.id, "roofing");
  const o = s.orders.find((x) => x.division === "roofing")!;
  assert.deepEqual([o.status, o.issuedAt, o.issuedBy], ["draft", null, null]);
  assert.equal(await code(setWorkOrderNotes(s, est1, job.id, "roofing", "fixed")), "ok");                // editable again
  assert.equal(await code(reopenWorkOrder(s, adm, job.id, "gutters")), "division_not_on_job");
  assert.equal(await code(reopenWorkOrder(s, adm, "nope", "roofing")), "not_found");
});

// ---------- PDF ----------
test("pdf data: only people who may see it; the crew gets nothing until it is issued; the customer is never named", async () => {
  const { s, job } = setup();
  await createWorkOrders(s, job.id, null);
  color(s, job.id);
  assert.equal(await code(workOrderPdfData(s, crew1, job.id, "roofing")), "not_found");                  // draft
  for (const who of [adm, est1, pmRoof]) assert.equal(await code(workOrderPdfData(s, who, job.id, "roofing")), "ok", who.id);
  for (const who of [est2, pmSide, pmGutter, crew2, crew3, csr, acct]) assert.equal(await code(workOrderPdfData(s, who, job.id, "roofing")), "not_found", who.id);
  await issueWorkOrder(s, est1, job.id, "roofing", () => new Date("2026-10-15T14:00:00Z"));
  const d = await workOrderPdfData(s, crew1, job.id, "roofing");
  assert.deepEqual([d.status, d.issuedOn, d.installDate, d.crewLeaderName, d.tradeLabel], ["issued", "2026-10-15", "2026-10-20", "Crew One", "Roofing"]);
  assert.deepEqual(d.materials.map((m) => [m.description, m.color]), [["Architectural shingles", "Charcoal"], ["Starter strip", "Black"]]);
  assert.equal(await code(workOrderPdfData(s, crew1, job.id, "siding")), "not_found");
  assert.equal(await code(workOrderPdfData(s, adm, job.id, "gutters")), "not_found");
  assert.equal(await code(workOrderPdfData(s, adm, "nope", "roofing")), "not_found");
});

test("pdf text: tasks with quantities and units, notes, materials with colors, no money, no customer", async () => {
  const { s, job } = setup();
  await createWorkOrders(s, job.id, null);
  color(s, job.id);
  await setWorkOrderNotes(s, est1, job.id, "roofing", "Gate code 1234");
  await setTaskNote(s, est1, job.id, "roofing", s.orders[0].lines[2].id, "Drop it by the garage");
  await issueWorkOrder(s, est1, job.id, "roofing", () => new Date("2026-10-15T14:00:00Z"));
  const { lines, heading } = workOrderText(await workOrderPdfData(s, adm, job.id, "roofing"));
  const text = lines.join("\n");
  assert.equal(heading, "A&A Exterior Group - Work order");
  for (const expected of ["Job 1: Roofing", "Issued 2026-10-15", "Address: 100 Example Rd, West Plains, MO 65775", "Install date: 2026-10-20", "Crew leader: Crew One", "Gate code 1234",
    "1. Tear off existing roof - 24.37 sq", "3. Dumpster - 1 ea", "Note: Drop it by the garage", "Architectural shingles - 27 sq - Charcoal", "Starter strip - 3 bundle - Black"]) assert.ok(text.includes(expected), expected);
  assert.ok(!/\$|price|cost|rate|margin|customer|phone/i.test(text));
});

test("pdf text: a draft says so, and missing colors and dates are plain", async () => {
  const { s, job } = setup();
  s.trades.set(job.id, []);
  await createWorkOrders(s, job.id, null);
  const text = workOrderText(await workOrderPdfData(s, adm, job.id, "roofing")).lines.join("\n");
  for (const expected of ["DRAFT - not issued yet", "Install date: not scheduled yet", "Crew leader: not assigned yet", "color not chosen yet"]) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes("Notes"));
});

test("pdf file: a real PDF, even with odd characters", async () => {
  const bytes = await renderWorkOrderPdf({
    jobNumber: 24, tradeLabel: "Roofing", address: "100 Example Rd", status: "issued", issuedOn: "2026-10-15", installDate: null, crewLeaderName: "Дана “Крю” 🙂",
    notes: "x ".repeat(400), tasks: Array.from({ length: 60 }, (_, i) => ({ description: `Task ${i + 1}`, quantity: i + 1.5, unit: "sq", note: i % 2 ? "a note" : null })),
    materials: [{ description: "Shingles", unit: "sq", quantity: 27, color: "Charcoal" }],
  });
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getTitle(), "Work order - job 24 - Roofing");
  assert.ok(doc.getPageCount() >= 2);                          // a long list continues on a second page
});
