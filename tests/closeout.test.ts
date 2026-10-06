import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import {
  CloseoutError, addItem, closeoutView, editItem, invoicePdfFor, issueInvoice, removeItem, sendInvoice, setItemDone, startPunchlist, voidInvoice,
  type SendInvoiceEmail,
} from "../src/lib/closeout/logic.ts";
import { MemoryCloseoutStore } from "../src/lib/closeout/memory-store.ts";
import { invoiceText, renderInvoicePdf, sha256Hex } from "../src/lib/closeout/pdf.ts";
import { canManageInvoice, canViewInvoice, punchRights } from "../src/lib/closeout/rights.ts";
import { starterItems } from "../src/lib/closeout/template.ts";
import type { Actor } from "../src/lib/production/types.ts";
import { arAging } from "../src/lib/reports/calc.ts";
import type { JobFact } from "../src/lib/reports/types.ts";

const adm: Actor = { id: "adm", role: "admin" };
const acct: Actor = { id: "acct", role: "accounting" };
const est1: Actor = { id: "est1", role: "estimator" };
const est2: Actor = { id: "est2", role: "estimator" };
const pmRoof: Actor = { id: "pmr", role: "production_manager" };
const pmSide: Actor = { id: "pms", role: "production_manager" };
const pmGutter: Actor = { id: "pmg", role: "production_manager" };
const crew1: Actor = { id: "crew1", role: "crew_leader" };      // assigned to roofing
const crew2: Actor = { id: "crew2", role: "crew_leader" };      // assigned to nothing on this job
const csr: Actor = { id: "csr", role: "csr" };

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof CloseoutError ? e.code : `other:${String(e)}`));
const NOW = new Date("2026-10-14T17:00:00Z");
const at = (ms = 0) => () => new Date(NOW.getTime() + ms);

/** A two-trade job (roofing + siding) in closeout, $10,000 contract, trades complete. */
function setup(over: Parameters<MemoryCloseoutStore["addJob"]>[0] = {}) {
  const s = new MemoryCloseoutStore();
  const job = s.addJob({ divisions: ["roofing", "siding"], ...over });
  s.trades.set(job.id, [
    { division: "roofing", status: "complete", crewLeaderId: "crew1" },
    { division: "siding", status: "complete", crewLeaderId: null },
  ]);
  s.pm.set("pmr", ["roofing"]); s.pm.set("pms", ["siding"]); s.pm.set("pmg", ["gutters"]);
  return { s, job };
}
const tickAll = async (s: MemoryCloseoutStore, jobId: string) => { for (const i of s.itemsOf(jobId)) await setItemDone(s, adm, jobId, i.id, true); };
const readyToInvoice = async (over: Parameters<typeof setup>[0] = {}) => {
  const ctx = setup(over);
  await startPunchlist(ctx.s, adm, ctx.job.id);
  await tickAll(ctx.s, ctx.job.id);
  return ctx;
};

// ---------- starter list ----------
test("starter list: whole-job items first, then each trade on the job in the job's order", () => {
  const items = starterItems(["siding", "roofing"]);
  assert.ok(items.slice(0, 5).every((i) => i.division === null));
  assert.deepEqual([...new Set(items.slice(5).map((i) => i.division))], ["siding", "roofing"]);
  assert.ok(items.every((i) => i.labelEn.length > 0 && i.labelEn.length <= 200 && i.labelRu && i.labelRu.length > 0));
  assert.equal(starterItems(["gutters"]).filter((i) => i.division === "roofing").length, 0);
  for (const d of ["roofing", "siding", "gutters", "windows_doors", "insulation", "spray_foam", "commercial"] as const) {
    assert.ok(starterItems([d]).some((i) => i.division === d), d);                 // every trade has at least one item of its own
  }
});

test("start: builds the list once, only in closeout, only for staff and the PM", async () => {
  const { s, job } = setup();
  assert.deepEqual(await startPunchlist(s, est1, job.id), { created: starterItems(["roofing", "siding"]).length });
  assert.deepEqual(await startPunchlist(s, adm, job.id), { created: 0 });          // never doubled
  assert.equal(s.itemsOf(job.id).length, starterItems(["roofing", "siding"]).length);

  const fresh = setup();
  for (const [who, expected] of [[crew1, "forbidden"], [crew2, "forbidden"], [csr, "forbidden"], [acct, "forbidden"], [est2, "forbidden"], [pmGutter, "forbidden"]] as const) {
    assert.equal(await code(startPunchlist(fresh.s, who, fresh.job.id)), expected, who.id);
  }
  assert.equal(fresh.s.itemsOf(fresh.job.id).length, 0);
  assert.equal(await code(startPunchlist(fresh.s, pmRoof, fresh.job.id)), "ok");

  for (const stage of ["in_production", "scheduled"] as const) {
    const x = setup({ stage });
    assert.equal(await code(startPunchlist(x.s, adm, x.job.id)), "wrong_stage", stage);
  }
  const done = setup({ stage: "invoiced" });
  assert.equal(await code(startPunchlist(done.s, adm, done.job.id)), "items_locked");
  assert.equal(await code(startPunchlist(s, adm, "nope")), "not_found");
});

// ---------- rights ----------
test("rights: who sees, ticks and manages which items", () => {
  const trades = [{ division: "roofing" as const, status: "complete" as const, crewLeaderId: "crew1" }, { division: "siding" as const, status: "scheduled" as const, crewLeaderId: null }];
  const job = { estimatorId: "est1" };
  const r = (a: Actor, pm: ("roofing" | "siding" | "gutters")[] = []) => punchRights(a, job, trades, pm);
  for (const a of [adm, est1]) {
    const x = r(a);
    assert.ok(x.canView && x.canTick("roofing") && x.canTick(null) && x.canManage("siding") && x.canManage(null) && x.canStart, a.id);
  }
  const pm = r(pmRoof, ["roofing"]);
  assert.ok(pm.canView && pm.canTick("roofing") && pm.canTick(null) && pm.canManage("roofing") && pm.canManage(null) && pm.canStart);
  assert.ok(!pm.canTick("siding") && !pm.canManage("siding") && !pm.canSee("siding"));
  const crew = r(crew1);
  assert.ok(crew.canView && crew.canTick("roofing") && crew.canTick(null));
  assert.ok(!crew.canManage("roofing") && !crew.canManage(null) && !crew.canStart && !crew.canTick("siding"));
  const acc = r(acct);
  assert.ok(acc.canView && acc.canSee("roofing") && acc.canSee("siding") && acc.canSee(null));
  assert.ok(!acc.canTick("roofing") && !acc.canManage(null) && !acc.canStart);
  for (const a of [est2, csr, crew2]) assert.ok(!r(a).canView, a.id);
  assert.ok(!r(pmGutter, ["gutters"]).canView);                          // a PM with no trade on this job
  // a crew leader assigned to a trade that is only proposed is not yet on it
  const proposed = punchRights(crew1, job, [{ division: "roofing", status: "proposed", crewLeaderId: "crew1" }], []);
  assert.ok(!proposed.canView);
});

test("rights: invoices are issued by admin and accounting; estimator and PM can view; crew and CSR cannot", () => {
  const trades = [{ division: "roofing" as const, status: "complete" as const, crewLeaderId: "crew1" }];
  assert.ok(canManageInvoice(adm) && canManageInvoice(acct));
  for (const a of [est1, pmRoof, crew1, csr]) assert.ok(!canManageInvoice(a), a.id);
  assert.ok(canViewInvoice(adm, { estimatorId: "est1" }, trades, []) && canViewInvoice(acct, { estimatorId: "est1" }, trades, []));
  assert.ok(canViewInvoice(est1, { estimatorId: "est1" }, trades, []) && !canViewInvoice(est2, { estimatorId: "est1" }, trades, []));
  assert.ok(canViewInvoice(pmRoof, { estimatorId: "est1" }, trades, ["roofing"]) && !canViewInvoice(pmGutter, { estimatorId: "est1" }, trades, ["gutters"]));
  assert.ok(!canViewInvoice(crew1, { estimatorId: "est1" }, trades, []) && !canViewInvoice(csr, { estimatorId: "est1" }, trades, []));
});

// ---------- view ----------
test("view: each role sees only what it may; crew screens never carry the customer or prices", async () => {
  const { s, job } = setup();
  await startPunchlist(s, adm, job.id);
  const total = s.itemsOf(job.id).length;
  const roofing = s.itemsOf(job.id).filter((i) => i.division === "roofing").length;
  const whole = s.itemsOf(job.id).filter((i) => i.division === null).length;

  const a = await closeoutView(s, adm, job.id);
  assert.equal(a.items.length, total);
  assert.deepEqual(a.progress, { done: 0, total });
  assert.equal(a.job.customerName, "Dana Miller");
  assert.ok(a.invoice?.canManage);
  assert.deepEqual(a.invoice?.gate, { ok: false, reason: "punchlist_open" });

  const c = await closeoutView(s, crew1, job.id);
  assert.equal(c.items.length, roofing + whole);
  assert.ok(c.items.every((i) => i.division === null || i.division === "roofing"));
  assert.equal(c.job.customerName, null);
  assert.equal(c.invoice, null);
  assert.ok(c.items.every((i) => i.canTick && !i.canEdit));
  assert.ok(!JSON.stringify(c).includes("1000000") && !JSON.stringify(c).includes("dana@example.com"));
  assert.equal(c.canAdd, null);
  assert.deepEqual(c.progress, { done: 0, total });              // progress counts the whole list, not just what they see

  const p = await closeoutView(s, pmSide, job.id);
  assert.ok(p.items.every((i) => i.division === null || i.division === "siding"));
  assert.ok(p.invoice && !p.invoice.canManage);
  assert.deepEqual(p.canAdd, { wholeJob: true, divisions: ["siding"] });

  const t = await closeoutView(s, acct, job.id);                  // accounting reads everything and changes nothing
  assert.equal(t.items.length, total);
  assert.ok(t.items.every((i) => !i.canTick && !i.canEdit));
  assert.ok(t.invoice?.canManage);
  assert.equal(t.canAdd, null);

  for (const [who, expected] of [[csr, "forbidden"], [est2, "forbidden"], [crew2, "forbidden"], [pmGutter, "forbidden"]] as const) {
    assert.equal(await code(closeoutView(s, who, job.id)), expected, who.id);
  }
  assert.equal(await code(closeoutView(s, adm, "nope")), "not_found");
});

test("view: before closeout there is no list and nothing to change; after invoicing everything is locked", async () => {
  const early = setup({ stage: "in_production" });
  const v = await closeoutView(early.s, adm, early.job.id);
  assert.deepEqual([v.items.length, v.editable, v.canStart], [0, false, false]);
  const { s, job } = await readyToInvoice();
  await issueInvoice(s, adm, job.id, at());
  const after = await closeoutView(s, adm, job.id);
  assert.equal(after.editable, false);
  assert.ok(after.items.every((i) => !i.canTick && !i.canEdit));
  assert.equal(after.canAdd, null);
});

// ---------- ticking and editing ----------
test("tick: roles with rights tick; the time and person are recorded; unticking clears them", async () => {
  const { s, job } = setup();
  await startPunchlist(s, adm, job.id);
  const roofItem = s.itemsOf(job.id).find((i) => i.division === "roofing")!;
  const sideItem = s.itemsOf(job.id).find((i) => i.division === "siding")!;
  const wholeItem = s.itemsOf(job.id).find((i) => i.division === null)!;

  await setItemDone(s, crew1, job.id, roofItem.id, true, at(1000));
  assert.deepEqual([roofItem.done, roofItem.doneBy, roofItem.doneAt?.toISOString()], [true, "crew1", new Date(NOW.getTime() + 1000).toISOString()]);
  await setItemDone(s, crew1, job.id, wholeItem.id, true, at());
  await setItemDone(s, pmSide, job.id, sideItem.id, true, at());
  await setItemDone(s, est1, job.id, sideItem.id, false, at());
  assert.deepEqual([sideItem.done, sideItem.doneBy, sideItem.doneAt], [false, null, null]);
  await setItemDone(s, est1, job.id, roofItem.id, true, at(5000));      // already done: nothing changes, nobody is overwritten
  assert.equal(roofItem.doneBy, "crew1");

  assert.equal(await code(setItemDone(s, crew1, job.id, sideItem.id, true)), "item_not_found");     // not their trade: told it doesn't exist
  assert.equal(await code(setItemDone(s, pmRoof, job.id, sideItem.id, true)), "item_not_found");
  assert.equal(await code(setItemDone(s, acct, job.id, roofItem.id, true)), "forbidden");           // sees it, may not tick it
  for (const who of [csr, est2, crew2, pmGutter]) assert.equal(await code(setItemDone(s, who, job.id, roofItem.id, true)), "item_not_found", who.id);
  assert.equal(await code(setItemDone(s, adm, job.id, "nope", true)), "item_not_found");
  assert.equal(await code(setItemDone(s, adm, "nope", roofItem.id, true)), "not_found");
});

test("add, rename, remove: staff and the PM of the trade; crew leaders cannot; labels are cleaned and limited", async () => {
  const { s, job } = setup();
  await startPunchlist(s, adm, job.id);
  const before = s.itemsOf(job.id).length;

  await addItem(s, est1, job.id, { division: null, labelEn: "  Collect   the\tkeys\n", labelRu: " Забрать ключи " });
  const added = s.itemsOf(job.id).at(-1)!;
  assert.deepEqual([added.labelEn, added.labelRu, added.division, s.itemsOf(job.id).length], ["Collect the keys", "Забрать ключи", null, before + 1]);
  await addItem(s, pmSide, job.id, { division: "siding", labelEn: "Touch up paint" });
  assert.equal(s.itemsOf(job.id).at(-1)!.labelRu, null);

  assert.equal(await code(addItem(s, pmSide, job.id, { division: "roofing", labelEn: "x" })), "forbidden");
  assert.equal(await code(addItem(s, crew1, job.id, { division: "roofing", labelEn: "x" })), "forbidden");
  assert.equal(await code(addItem(s, acct, job.id, { division: null, labelEn: "x" })), "forbidden");
  assert.equal(await code(addItem(s, csr, job.id, { division: null, labelEn: "x" })), "forbidden");
  assert.equal(await code(addItem(s, adm, job.id, { division: "gutters", labelEn: "x" })), "division_not_on_job");
  for (const bad of ["", "   ", "x".repeat(201), null, 5, {}]) assert.equal(await code(addItem(s, adm, job.id, { division: null, labelEn: bad })), "label_invalid", String(bad));
  assert.equal(await code(addItem(s, adm, job.id, { division: null, labelEn: "ok", labelRu: "y".repeat(201) })), "label_invalid");

  await editItem(s, pmSide, job.id, added.id, { labelEn: "Collect all keys" });           // a PM may edit whole-job items
  assert.equal(added.labelEn, "Collect all keys");
  const sideItem = s.itemsOf(job.id).find((i) => i.division === "siding")!;
  await editItem(s, pmSide, job.id, sideItem.id, { labelEn: "Siding walked and approved", labelRu: null });
  assert.deepEqual([sideItem.labelEn, sideItem.labelRu], ["Siding walked and approved", null]);
  assert.equal(await code(editItem(s, pmRoof, job.id, sideItem.id, { labelEn: "x" })), "item_not_found");
  assert.equal(await code(editItem(s, crew1, job.id, s.itemsOf(job.id).find((i) => i.division === "roofing")!.id, { labelEn: "x" })), "forbidden");
  assert.equal(await code(editItem(s, adm, job.id, sideItem.id, { labelEn: "" })), "label_invalid");

  await removeItem(s, adm, job.id, added.id);
  assert.equal(s.itemsOf(job.id).length, before + 1);
  assert.equal(await code(removeItem(s, crew1, job.id, s.itemsOf(job.id).find((i) => i.division === "roofing")!.id)), "forbidden");
  assert.equal(await code(removeItem(s, adm, job.id, "nope")), "item_not_found");
});

test("add: a punchlist holds at most 100 items", async () => {
  const { s, job } = setup();
  await startPunchlist(s, adm, job.id);
  while (s.itemsOf(job.id).length < 100) await addItem(s, adm, job.id, { division: null, labelEn: `item ${s.itemsOf(job.id).length}` });
  assert.equal(await code(addItem(s, adm, job.id, { division: null, labelEn: "one more" })), "too_many_items");
});

test("edits are refused before closeout and once the job is invoiced", async () => {
  const early = setup({ stage: "in_production" });
  assert.equal(await code(addItem(early.s, adm, early.job.id, { division: null, labelEn: "x" })), "wrong_stage");
  const { s, job } = await readyToInvoice();
  const item = s.itemsOf(job.id)[0];
  await issueInvoice(s, adm, job.id, at());
  assert.equal(await code(setItemDone(s, adm, job.id, item.id, false)), "items_locked");
  assert.equal(await code(addItem(s, adm, job.id, { division: null, labelEn: "x" })), "items_locked");
  assert.equal(await code(editItem(s, adm, job.id, item.id, { labelEn: "x" })), "items_locked");
  assert.equal(await code(removeItem(s, adm, job.id, item.id)), "items_locked");
  assert.ok(s.itemsOf(job.id).every((i) => i.done));              // nothing was undone
});

// ---------- issuing ----------
test("issue: blocked until the list exists, is complete, and the contract is signed; roles are checked", async () => {
  const { s, job } = setup();
  assert.equal(await code(issueInvoice(s, adm, job.id, at())), "no_punchlist");
  await startPunchlist(s, adm, job.id);
  assert.equal(await code(issueInvoice(s, adm, job.id, at())), "punchlist_open");
  const items = s.itemsOf(job.id);
  for (const i of items.slice(0, -1)) await setItemDone(s, adm, job.id, i.id, true);
  assert.equal(await code(issueInvoice(s, adm, job.id, at())), "punchlist_open");             // one left
  await setItemDone(s, adm, job.id, items.at(-1)!.id, true);
  for (const who of [est1, pmRoof, crew1, csr, est2]) assert.equal(await code(issueInvoice(s, who, job.id, at())), "forbidden", who.id);
  assert.equal(s.invoices.length, 0);
  s.jobs[0].contractSigned = false;
  assert.equal(await code(issueInvoice(s, adm, job.id, at())), "no_contract");
  s.jobs[0].contractSigned = true; s.jobs[0].stage = "in_production";
  assert.equal(await code(issueInvoice(s, adm, job.id, at())), "wrong_stage");
  assert.equal(await code(issueInvoice(s, adm, "nope", at())), "not_found");
  assert.equal(s.invoices.length, 0);
});

test("issue: a snapshot of contract, paid and balance; due on receipt; stage moves to invoiced with a history row", async () => {
  const { s, job } = await readyToInvoice();
  s.pay(job.id, 400_000); s.pay(job.id, 100_000); s.pay(job.id, 999_999, true);            // the voided one never counts
  const r = await issueInvoice(s, acct, job.id, at());
  assert.equal(r.stage, "invoiced");
  const inv = r.invoice;
  assert.deepEqual([inv.invoiceNumber, inv.contractCents, inv.paidCents, inv.balanceCents, inv.status, inv.issuedBy], [1001, 1_000_000, 500_000, 500_000, "issued", "acct"]);
  assert.equal(inv.dueOn, "2026-10-14");                                                  // due on receipt: the invoice date
  assert.equal(s.jobs[0].stage, "invoiced");
  assert.deepEqual(s.stageHistory.map((h) => [h.from, h.to, h.by]), [["closeout_punchlist", "invoiced", "acct"]]);
  const pdf = (await s.getInvoicePdf(inv.id))!;
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getTitle(), "Invoice 1001");
  assert.ok(doc.getPageCount() >= 1);
  assert.equal(sha256Hex(pdf), sha256Hex(pdf));
});

test("issue: the invoice date is the Central-time date, not the UTC date", async () => {
  const late = await readyToInvoice();
  const r = await issueInvoice(late.s, adm, late.job.id, () => new Date("2026-10-15T03:30:00Z"));      // 10:30 pm Central on the 14th
  assert.equal(r.invoice.dueOn, "2026-10-14");
});

test("issue: the snapshot never changes when more payments arrive, and the live balance does", async () => {
  const { s, job } = await readyToInvoice();
  s.pay(job.id, 200_000);
  const inv = (await issueInvoice(s, adm, job.id, at())).invoice;
  s.pay(job.id, 300_000);
  const stored = (await s.getInvoice(inv.id))!;
  assert.deepEqual([stored.paidCents, stored.balanceCents], [200_000, 800_000]);
  const v = await closeoutView(s, adm, job.id);
  assert.deepEqual([v.invoice!.collectedCents, v.invoice!.balanceCents], [500_000, 500_000]);
  assert.equal(v.invoice!.live!.balanceCents, 800_000);          // what the customer was told
  assert.deepEqual(v.invoice!.gate, { ok: false, reason: "invoice_exists" });
});

test("issue: a job with nothing owed goes straight through to paid in full", async () => {
  const { s, job } = await readyToInvoice();
  s.pay(job.id, 1_000_000);
  const r = await issueInvoice(s, adm, job.id, at());
  assert.equal(r.invoice.balanceCents, 0);
  assert.equal(r.stage, "paid_in_full");
  assert.deepEqual(s.stageHistory.map((h) => [h.from, h.to]), [["closeout_punchlist", "invoiced"], ["invoiced", "paid_in_full"]]);
  assert.match(invoiceText({ invoiceNumber: 1, jobNumber: 1, customerName: "x", propertyAddress: "y", issuedOn: "2026-10-14", dueOn: "2026-10-14", sections: [], contractCents: 100, paidCents: 100, balanceCents: 0 }).lines.join("\n"), /paid in full/);
});

test("issue: one live invoice per job, and two people issuing at once creates exactly one", async () => {
  const { s, job } = await readyToInvoice();
  const results = await Promise.all([issueInvoice(s, adm, job.id, at()), issueInvoice(s, acct, job.id, at()), issueInvoice(s, adm, job.id, at())].map((p) => code(p)));
  assert.deepEqual(results.sort(), ["invoice_exists", "invoice_exists", "ok"]);
  assert.equal(s.invoices.length, 1);
  assert.equal(s.invoices[0].invoiceNumber, 1001);                // the losers did not use up a number
  assert.equal(s.stageHistory.length, 1);
});

test("issue: invoice numbers count up across jobs", async () => {
  const a = await readyToInvoice();
  const b = a.s.addJob({ divisions: ["roofing"] });
  a.s.trades.set(b.id, [{ division: "roofing", status: "complete", crewLeaderId: null }]);
  await startPunchlist(a.s, adm, b.id); await tickAll(a.s, b.id);
  const first = await issueInvoice(a.s, adm, a.job.id, at());
  const second = await issueInvoice(a.s, adm, b.id, at());
  assert.deepEqual([first.invoice.invoiceNumber, second.invoice.invoiceNumber], [1001, 1002]);
});

// ---------- void and reissue ----------
test("void: a reason is required; the stage stays; a new invoice can then be issued with a new number", async () => {
  const { s, job } = await readyToInvoice();
  await issueInvoice(s, adm, job.id, at());
  assert.equal(await code(voidInvoice(s, adm, job.id, "")), "reason_required");
  assert.equal(await code(voidInvoice(s, adm, job.id, "ab")), "reason_required");
  assert.equal(await code(voidInvoice(s, adm, job.id, "x".repeat(301))), "reason_required");
  for (const who of [est1, pmRoof, crew1, csr]) assert.equal(await code(voidInvoice(s, who, job.id, "wrong amount")), "forbidden", who.id);
  assert.equal(s.invoices[0].status, "issued");

  await voidInvoice(s, acct, job.id, "  wrong price  ", at(1000));
  assert.deepEqual([s.invoices[0].status, s.invoices[0].voidReason], ["void", "wrong price"]);
  assert.equal(s.jobs[0].stage, "invoiced");                       // not moved backward
  assert.equal(await code(voidInvoice(s, adm, job.id, "again")), "no_invoice");

  s.pay(job.id, 250_000);                                          // a payment arrived meanwhile: the new invoice reflects it
  const again = await issueInvoice(s, adm, job.id, at(2000));
  assert.deepEqual([again.invoice.invoiceNumber, again.invoice.paidCents, again.invoice.balanceCents], [1002, 250_000, 750_000]);
  assert.equal(s.stageHistory.length, 1);                          // the "invoiced" history row (and the AR date) is not repeated
  const v = await closeoutView(s, adm, job.id);
  assert.deepEqual([v.invoice!.live!.invoiceNumber, v.invoice!.history.map((h) => h.invoiceNumber), v.invoice!.history[0].voidReason], [1002, [1001], "wrong price"]);
});

test("void: nothing to void before invoicing or once the job is paid in full", async () => {
  const { s, job } = await readyToInvoice();
  assert.equal(await code(voidInvoice(s, adm, job.id, "mistake")), "no_invoice");
  s.pay(job.id, 1_000_000);
  await issueInvoice(s, adm, job.id, at());
  assert.equal(s.jobs[0].stage, "paid_in_full");
  assert.equal(await code(voidInvoice(s, adm, job.id, "mistake")), "wrong_stage");
  assert.equal(await code(voidInvoice(s, adm, "nope", "mistake")), "not_found");
});

// ---------- email ----------
const okSend = (log: Parameters<SendInvoiceEmail>[0][] = []): SendInvoiceEmail => async (a) => { log.push(a); };

test("send: emails the PDF to the customer on file and records it; or to an address typed in", async () => {
  const { s, job } = await readyToInvoice();
  await issueInvoice(s, adm, job.id, at());
  const log: Parameters<SendInvoiceEmail>[0][] = [];
  assert.deepEqual(await sendInvoice(s, acct, job.id, {}, okSend(log), at(5000)), { to: "dana@example.com" });
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].invoiceNumber, log[0].jobNumber, log[0].balanceCents, log[0].customerName], [1001, 1, 1_000_000, "Dana Miller"]);
  assert.ok(log[0].pdf.length > 500);
  assert.deepEqual([s.invoices[0].emailStatus, s.invoices[0].emailedTo, s.invoices[0].emailError], ["sent", "dana@example.com", null]);
  await sendInvoice(s, adm, job.id, { to: "  spouse@example.com " }, okSend(log), at(6000));
  assert.equal(s.invoices[0].emailedTo, "spouse@example.com");
});

test("send: refusals for role, missing or bad address, and no invoice", async () => {
  const { s, job } = await readyToInvoice({ customerEmail: null });
  assert.equal(await code(sendInvoice(s, adm, job.id, {}, okSend())), "no_invoice");
  await issueInvoice(s, adm, job.id, at());
  assert.equal(await code(sendInvoice(s, adm, job.id, {}, okSend())), "no_email");
  for (const bad of ["not an email", "a@b", "@x.com", "a b@c.com", `${"x".repeat(250)}@e.com`]) assert.equal(await code(sendInvoice(s, adm, job.id, { to: bad }, okSend())), "email_invalid", bad);
  for (const who of [est1, pmRoof, crew1, csr]) assert.equal(await code(sendInvoice(s, who, job.id, { to: "a@b.com" }, okSend())), "forbidden", who.id);
  assert.equal(await code(sendInvoice(s, adm, "nope", { to: "a@b.com" }, okSend())), "not_found");
  assert.equal(s.invoices[0].emailStatus, null);
});

test("send: a failed email is recorded, never loses the invoice, and can be sent again", async () => {
  const { s, job } = await readyToInvoice();
  await issueInvoice(s, adm, job.id, at());
  const failing: SendInvoiceEmail = async () => { throw new Error("provider said: secret-api-key-123 rejected"); };
  assert.equal(await code(sendInvoice(s, adm, job.id, {}, failing, at(1000))), "email_failed");
  assert.deepEqual([s.invoices[0].status, s.invoices[0].emailStatus, s.invoices[0].emailError], ["issued", "failed", "The email could not be sent"]);
  assert.ok(!JSON.stringify(s.invoices[0].emailError).includes("secret-api-key"));          // nothing from the provider is stored
  await sendInvoice(s, adm, job.id, {}, okSend(), at(2000));
  assert.deepEqual([s.invoices[0].emailStatus, s.invoices[0].emailError], ["sent", null]);
});

test("send: only the live invoice goes out, never a voided one", async () => {
  const { s, job } = await readyToInvoice();
  await issueInvoice(s, adm, job.id, at());
  await voidInvoice(s, adm, job.id, "wrong amount", at(1000));
  assert.equal(await code(sendInvoice(s, adm, job.id, {}, okSend())), "no_invoice");
});

// ---------- PDF download ----------
test("pdf: admin, accounting, the job's estimator and a PM with a trade can download; everyone else is told it doesn't exist", async () => {
  const { s, job } = await readyToInvoice();
  const inv = (await issueInvoice(s, adm, job.id, at())).invoice;
  for (const who of [adm, acct, est1, pmRoof, pmSide]) {
    const r = await invoicePdfFor(s, who, inv.id);
    assert.equal(r.filename, "invoice-1001.pdf");
    assert.equal(new TextDecoder().decode(r.pdf.slice(0, 5)), "%PDF-");
  }
  for (const who of [est2, crew1, crew2, csr, pmGutter]) assert.equal(await code(invoicePdfFor(s, who, inv.id)), "not_found", who.id);
  assert.equal(await code(invoicePdfFor(s, adm, "nope")), "not_found");
});

// ---------- PDF content ----------
const data = {
  invoiceNumber: 1001, jobNumber: 24, customerName: "Dana Miller", propertyAddress: "100 Example Rd, West Plains, MO 65775",
  issuedOn: "2026-10-14", dueOn: "2026-10-14",
  sections: [{ divisionLabel: "Roofing", packageTitle: "Better", subtotalCents: 700_000 }, { divisionLabel: "Siding", packageTitle: "Good", subtotalCents: 300_000 }],
  contractCents: 1_000_000, paidCents: 500_000, balanceCents: 500_000,
};

test("invoice text: total, payments, balance and terms; no cost, margin or commission anywhere", () => {
  const { lines, heading } = invoiceText(data);
  const text = lines.join("\n");
  assert.equal(heading, "A&A Exterior Group - Invoice");
  for (const expected of ["Invoice 1001", "Date: 2026-10-14", "Due: on receipt", "Job: 24", "Customer: Dana Miller", "Roofing: Better - $7,000.00", "Siding: Good - $3,000.00",
    "Total contract price: $10,000.00", "Payments received: $5,000.00", "Balance due: $5,000.00", "Terms: due on receipt."]) assert.ok(text.includes(expected), expected);
  assert.ok(!/margin|cost|commission|profit/i.test(text));
  assert.equal(invoiceText({ ...data, dueOn: "2026-10-24" }).lines[2], "Due: 2026-10-24");
  assert.ok(!invoiceText({ ...data, balanceCents: 0, paidCents: 1_000_000 }).lines.join("\n").includes("Terms: due on receipt"));
});

test("invoice pdf: a real PDF even with odd characters in names; the same data always gives the same text", async () => {
  const bytes = await renderInvoicePdf({ ...data, customerName: "Дана “Миллер” – 🙂", propertyAddress: "100 Example Rd, \u0000West Plains" });
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getTitle(), "Invoice 1001");
  assert.deepEqual(invoiceText(data), invoiceText({ ...data }));
});

// ---------- AR aging ----------
test("AR aging: an invoiced job with a balance appears in the right bucket, aged from the invoice date", async () => {
  const { s, job } = await readyToInvoice();
  s.pay(job.id, 400_000);
  await issueInvoice(s, adm, job.id, at());
  const invoicedDate = s.stageHistory.find((h) => h.to === "invoiced") ? "2026-10-14" : null;
  const fact = (today: string) => arAging([{
    jobId: job.id, jobNumber: job.jobNumber, jobType: "retail", divisions: ["roofing"], source: "phone", estimatorId: "est1", stage: s.jobs[0].stage,
    createdDate: "2026-08-01", contractCents: s.jobs[0].contractCents, wonDate: "2026-08-02", inProductionDate: null, installDate: null,
    invoicedDate, collectedCents: await0(s, job.id), depositRequiredCents: 0, depositPaidCents: 0,
  } satisfies JobFact], today);
  const day10 = fact("2026-10-24");
  assert.deepEqual([day10.rows.length, day10.rows[0].balanceCents, day10.rows[0].ageDays, day10.rows[0].bucket], [1, 600_000, 10, "0-30"]);
  assert.equal(fact("2026-12-14").rows[0].bucket, "61-90");
  s.pay(job.id, 600_000);
  s.jobs[0].stage = "paid_in_full";
  assert.equal(fact("2026-10-24").rows.length, 0);                 // paid up: off the report
});
function await0(s: MemoryCloseoutStore, jobId: string): number {
  return s.payments.filter((p) => p.jobId === jobId && !p.voided).reduce((t, p) => t + p.amountCents, 0);
}
