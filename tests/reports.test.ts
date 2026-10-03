import { test } from "node:test";
import assert from "node:assert/strict";
import { costPerCents, rateBps } from "../src/lib/rules.ts";
import {
  arAging, arBucketFor, closeRate, commissionsOwed, costBySource, daysBetween, depositsOutstanding, depreciationOutstanding,
  installDays, monthsTouched, sales, wholeMonthRange,
} from "../src/lib/reports/calc.ts";
import { csvCell, toCsv } from "../src/lib/reports/csv.ts";
import { canSeeReport, groupingsFor, reportsFor, visibleFacts } from "../src/lib/reports/access.ts";
import { ReportError, buildReport, parseRange, presetRange } from "../src/lib/reports/logic.ts";
import { MemoryReportStore } from "../src/lib/reports/memory-store.ts";
import { MemoryCommissionStore } from "../src/lib/commission/memory-store.ts";
import type { JobFact } from "../src/lib/reports/types.ts";
import type { Role } from "../src/lib/auth/roles.ts";

let n = 0;
const fact = (o: Partial<JobFact> = {}): JobFact => ({
  jobId: `j${++n}`, jobNumber: n, jobType: "retail", divisions: ["siding"], source: "phone", estimatorId: "est1", stage: "new_lead",
  createdDate: "2026-10-05", contractCents: null, wonDate: null, inProductionDate: null, installDate: null, invoicedDate: null,
  collectedCents: 0, depositRequiredCents: 0, depositPaidCents: 0, ...o,
});
const won = (o: Partial<JobFact> = {}) => fact({ stage: "contract_signed", contractCents: 1_000_000, wonDate: o.createdDate ?? "2026-10-06", ...o });
const OCT = { from: "2026-10-01", to: "2026-10-31" };

test("rules: rate and cost-per helpers", () => {
  assert.equal(rateBps(1, 3), 3333);
  assert.equal(rateBps(2, 3), 6667);
  assert.equal(rateBps(0, 0), 0);
  assert.equal(rateBps(5, 5), 10000);
  assert.equal(costPerCents(200_000, 6), 33_333);   // $333.33
  assert.equal(costPerCents(200_000, 0), null);
  assert.equal(costPerCents(0, 4), 0);
});

// ---------- close rate ----------
test("close rate: won / all leads, with lost, open and the decided rate beside it", () => {
  const facts = [won(), won(), fact({ stage: "lost" }), fact({ stage: "inspected" })];
  const { rows, total } = closeRate(facts, OCT, "source");
  assert.deepEqual(rows[0], { key: "phone", leads: 4, won: 2, lost: 1, open: 1, closeRateBps: 5000, decidedRateBps: 6667 });
  assert.equal(total.leads, 4);
});

test("close rate: counts leads by created date; a later win still counts for the lead's month", () => {
  const sepLead = fact({ createdDate: "2026-09-28", stage: "contract_signed", contractCents: 500_000, wonDate: "2026-10-05" });
  const octLead = fact();
  const sep = closeRate([sepLead, octLead], { from: "2026-09-01", to: "2026-09-30" }, "source");
  assert.deepEqual([sep.total.leads, sep.total.won], [1, 1]);
  const oct = closeRate([sepLead, octLead], OCT, "source");
  assert.deepEqual([oct.total.leads, oct.total.won], [1, 0]);
});

test("close rate: paid condition reports are not leads; empty ranges are zero not NaN", () => {
  const { total } = closeRate([fact({ jobType: "condition_report" })], OCT, "source");
  assert.deepEqual([total.leads, total.closeRateBps, total.decidedRateBps], [0, 0, 0]);
});

test("close rate: groups by estimator (with Unassigned) and by primary division", () => {
  const facts = [fact({ estimatorId: null }), fact({ estimatorId: "est2" }), fact({ divisions: ["roofing", "gutters"] })];
  assert.deepEqual(closeRate(facts, OCT, "estimator").rows.map((r) => [r.key, r.leads]).sort(), [["est1", 1], ["est2", 1], ["unassigned", 1]]);
  assert.deepEqual(closeRate(facts, OCT, "division").rows.map((r) => [r.key, r.leads]).sort(), [["roofing", 1], ["siding", 2]]);
});

test("close rate: a job cancelled after approval counts as lost, not won", () => {
  const { total } = closeRate([fact({ stage: "cancelled_after_approval" })], OCT, "source");
  assert.deepEqual([total.won, total.lost], [0, 1]);
});

// ---------- sales ----------
test("sales: contract totals by the day the contract was signed, not created", () => {
  const facts = [
    won({ createdDate: "2026-09-20", wonDate: "2026-10-02", contractCents: 2_000_000 }),
    won({ createdDate: "2026-10-03", wonDate: "2026-10-10", contractCents: 1_000_001 }),
    won({ wonDate: "2026-11-02" }),
    fact({ stage: "lost" }),
  ];
  const { rows, total } = sales(facts, OCT, "division");
  assert.deepEqual(rows, [{ key: "siding", jobs: 2, salesCents: 3_000_001, averageCents: 1_500_001 }]);
  assert.equal(total.salesCents, 3_000_001);
});

test("sales: a multi-division job counts fully under its first division; unassigned and by rep", () => {
  const facts = [won({ divisions: ["roofing", "gutters"], contractCents: 900_000 }), won({ estimatorId: null, contractCents: 100_000 })];
  assert.deepEqual(sales(facts, OCT, "division").rows.map((r) => [r.key, r.salesCents]), [["roofing", 900_000], ["siding", 100_000]]);
  assert.deepEqual(sales(facts, OCT, "estimator").rows.map((r) => [r.key, r.salesCents]), [["est1", 900_000], ["unassigned", 100_000]]);
});

test("sales: nothing sold is an empty list with a zero total", () => {
  const r = sales([], OCT, "division");
  assert.deepEqual([r.rows.length, r.total.salesCents, r.total.averageCents], [0, 0, 0]);
});

// ---------- cost per lead ----------
test("cost: spend divided by leads and by won jobs; not-entered stays null", () => {
  const facts = [won({ source: "phone" }), fact({ source: "phone" }), fact({ source: "phone" }), fact({ source: "facebook" })];
  const spend = [{ source: "phone", month: "2026-10", spendCents: 200_000 }];
  const { rows } = costBySource(facts, spend, OCT);
  const phone = rows.find((r) => r.source === "phone")!;
  const fb = rows.find((r) => r.source === "facebook")!;
  assert.deepEqual([phone.leads, phone.won, phone.spendCents, phone.costPerLeadCents, phone.costPerWinCents], [3, 1, 200_000, 66_667, 200_000]);
  assert.deepEqual([fb.spendCents, fb.costPerLeadCents, fb.costPerWinCents], [null, null, null]);
});

test("cost: zero spend is a real zero, and zero wins gives no cost per win", () => {
  const { rows } = costBySource([fact({ source: "demandiq" })], [{ source: "demandiq", month: "2026-10", spendCents: 0 }], OCT);
  assert.deepEqual([rows[0].spendCents, rows[0].costPerLeadCents, rows[0].costPerWinCents], [0, 0, null]);
});

test("cost: a partial-month range is widened to whole months and sums spend across months", () => {
  const facts = [fact({ createdDate: "2026-10-02" }), fact({ createdDate: "2026-11-25" })];
  const spend = [{ source: "phone", month: "2026-10", spendCents: 100_000 }, { source: "phone", month: "2026-11", spendCents: 50_000 }];
  const r = costBySource(facts, spend, { from: "2026-10-20", to: "2026-11-05" });
  assert.deepEqual(r.months, ["2026-10", "2026-11"]);
  assert.deepEqual([r.rows[0].leads, r.rows[0].spendCents], [2, 150_000]);
});

test("month helpers across a year boundary", () => {
  assert.deepEqual(monthsTouched({ from: "2026-11-15", to: "2027-01-02" }), ["2026-11", "2026-12", "2027-01"]);
  assert.deepEqual(wholeMonthRange({ from: "2028-02-10", to: "2028-02-12" }), { from: "2028-02-01", to: "2028-02-29" });
  assert.equal(daysBetween("2026-02-28", "2026-03-01"), 1);
  assert.equal(daysBetween("2026-10-03", "2026-10-03"), 0);
});

// ---------- install days ----------
test("install days: averages won-to-production days, falls back to scheduled install date", () => {
  const facts = [
    won({ wonDate: "2026-10-01", inProductionDate: "2026-10-11" }),                           // 10 days
    won({ wonDate: "2026-10-02", installDate: "2026-10-17" }),                                // 15 days (scheduled)
    won({ wonDate: "2026-10-03", inProductionDate: "2026-10-05", installDate: "2026-10-30" }), // production date wins: 2 days
    won({ wonDate: "2026-09-01", inProductionDate: "2026-09-10" }),                           // won outside the range
    won({ wonDate: "2026-10-04" }),                                                           // no install info
  ];
  const { total, rows } = installDays(facts, OCT);
  assert.deepEqual([total?.jobs, total?.averageDaysTenths, total?.minDays, total?.maxDays], [3, 90, 2, 15]);
  assert.equal(rows[0].key, "siding");
});

test("install days: nothing to measure gives no total; negative gaps never go below zero", () => {
  assert.deepEqual(installDays([won()], OCT), { rows: [], total: null });
  assert.equal(installDays([won({ wonDate: "2026-10-10", installDate: "2026-10-01" })], OCT).total?.minDays, 0);
});

// ---------- AR aging ----------
test("ar aging: bucket edges at 30/31/60/61/90/91 days", () => {
  assert.deepEqual([0, 30, 31, 60, 61, 90, 91, 400].map(arBucketFor), ["0-30", "0-30", "31-60", "31-60", "61-90", "61-90", "91+", "91+"]);
});

test("ar aging: balance on invoiced jobs only, aged from the invoice date, paid-up jobs excluded", () => {
  const today = "2026-10-03";
  const facts = [
    fact({ stage: "invoiced", contractCents: 1_000_000, collectedCents: 400_000, invoicedDate: "2026-09-03" }),   // 30 days, 600k
    fact({ stage: "depreciation_pending", contractCents: 500_000, collectedCents: 100_000, invoicedDate: "2026-07-01" }), // 94 days
    fact({ stage: "invoiced", contractCents: 700_000, collectedCents: 700_000, invoicedDate: "2026-09-01" }),     // paid up
    fact({ stage: "paid_in_full", contractCents: 700_000, collectedCents: 100, invoicedDate: "2026-01-01" }),     // paid in full stage
    fact({ stage: "in_production", contractCents: 700_000, collectedCents: 0 }),                                  // not invoiced yet
  ];
  const r = arAging(facts, today);
  assert.deepEqual(r.rows.map((x) => [x.balanceCents, x.ageDays, x.bucket]), [[400_000, 94, "91+"], [600_000, 30, "0-30"]]);
  assert.equal(r.totalCents, 1_000_000);
  assert.deepEqual(r.buckets.map((b) => [b.bucket, b.jobs]), [["0-30", 1], ["31-60", 0], ["61-90", 0], ["91+", 1]]);
});

test("ar aging: no invoiced jobs is empty", () => {
  assert.deepEqual(arAging([fact()], "2026-10-03"), { rows: [], buckets: [{ bucket: "0-30", jobs: 0, totalCents: 0 }, { bucket: "31-60", jobs: 0, totalCents: 0 }, { bucket: "61-90", jobs: 0, totalCents: 0 }, { bucket: "91+", jobs: 0, totalCents: 0 }], totalCents: 0 });
});

// ---------- deposits ----------
test("deposits outstanding: only signed jobs whose deposit isn't covered, oldest first", () => {
  const facts = [
    won({ wonDate: "2026-09-26", depositRequiredCents: 500_000, depositPaidCents: 200_000 }),   // due 300k, 7 days
    won({ wonDate: "2026-10-01", depositRequiredCents: 100_000, depositPaidCents: 0 }),         // due 100k, 2 days
    won({ depositRequiredCents: 100_000, depositPaidCents: 100_000 }),                          // covered
    won({ depositRequiredCents: 0 }),                                                           // none required
    fact({ stage: "deposit_collected", depositRequiredCents: 100_000, depositPaidCents: 0 }),   // already moved on
  ];
  const r = depositsOutstanding(facts, "2026-10-03");
  assert.deepEqual(r.rows.map((x) => [x.dueCents, x.ageDays]), [[300_000, 7], [100_000, 2]]);
  assert.equal(r.totalCents, 400_000);
});

// ---------- depreciation, commissions ----------
test("depreciation: only amounts still held by the carrier", () => {
  const base = { jobId: "a", jobNumber: 1, divisions: ["roofing" as const], estimatorId: "est1", carrier: "Acme", claimNumber: "C1" };
  const r = depreciationOutstanding([
    { ...base, depreciationCents: 300_000, depreciationReceivedAt: null },
    { ...base, jobId: "b", jobNumber: 2, depreciationCents: 900_000, depreciationReceivedAt: "2026-09-01" },
    { ...base, jobId: "c", jobNumber: 3, depreciationCents: 0, depreciationReceivedAt: null },
  ]);
  assert.deepEqual(r.rows.map((x) => x.jobNumber), [1]);
  assert.equal(r.totalCents, 300_000);
});

test("commissions owed: net of draws, zero rows hidden, biggest first", () => {
  const r = commissionsOwed([
    { estimatorId: "a", name: "Alpha", unpaidCents: 100_000, drawsOutstandingCents: 30_000 },
    { estimatorId: "b", name: "Bravo", unpaidCents: 50_000, drawsOutstandingCents: 80_000 },   // draw bigger than earned
    { estimatorId: "c", name: "Charlie", unpaidCents: 0, drawsOutstandingCents: 0 },            // nothing: hidden
    { estimatorId: "d", name: "Delta", unpaidCents: -20_000, drawsOutstandingCents: 0 },        // clawback pays nothing
  ]);
  assert.deepEqual(r.rows.map((x) => [x.name, x.netPayableCents]), [["Alpha", 70_000], ["Bravo", 0], ["Delta", 0]]);
  assert.equal(r.totalNetCents, 70_000);
});

// ---------- csv ----------
test("csv: quotes, commas and newlines are escaped; formulas are neutralised", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  for (const bad of ["=SUM(A1)", "+1+1", "-2+3", "@cmd", "\t=x"]) assert.ok(csvCell(bad).startsWith("'"), bad);
  assert.equal(csvCell(-5), "-5");   // a real negative number is left alone
  assert.equal(csvCell(null), "");
});

test("csv: table with money in dollars and percents as numbers, totals row included", () => {
  const csv = toCsv({
    name: "x", title: "x",
    columns: [{ key: "g", label: "Name", kind: "text" }, { key: "s", label: "Sales", kind: "money" }, { key: "p", label: "Rate", kind: "percent" }],
    rows: [{ g: "=HYPERLINK(\"evil\")", s: 123_456, p: 4250 }, { g: "Smith, Jo", s: -5_000, p: null }],
    totals: { g: "Total", s: 118_456, p: null },
  });
  assert.equal(csv, 'Name,Sales,Rate\r\n"\'=HYPERLINK(""evil"")",1234.56,42.5\r\n"Smith, Jo",-50.00,\r\nTotal,1184.56,\r\n');
});

// ---------- access ----------
test("access: which reports each role may open, and which groupings", () => {
  assert.equal(reportsFor("admin").length, 8);
  assert.equal(reportsFor("accounting").length, 8);
  assert.deepEqual(reportsFor("production_manager"), ["close-rate", "sales", "install-days"]);
  assert.deepEqual(reportsFor("estimator"), ["close-rate", "sales"]);
  assert.deepEqual(reportsFor("csr"), ["close-rate"]);
  assert.deepEqual(reportsFor("crew_leader"), []);
  assert.ok(!canSeeReport("estimator", "cost-per-lead") && !canSeeReport("production_manager", "commissions-owed"));
  assert.deepEqual(groupingsFor("csr", "close-rate"), ["source"]);
  assert.deepEqual(groupingsFor("csr", "sales"), []);
  assert.deepEqual(groupingsFor("admin", "close-rate"), ["estimator", "division", "source"]);
});

test("access: PMs see their divisions' jobs, estimators their own, CSR and admin all", () => {
  const facts = [fact({ divisions: ["siding"] }), fact({ divisions: ["roofing"] }), fact({ estimatorId: "est2", divisions: ["roofing", "siding"] })];
  assert.equal(visibleFacts({ id: "pm", role: "production_manager" }, facts, ["roofing"]).length, 2); // primary division decides
  assert.equal(visibleFacts({ id: "pm", role: "production_manager" }, facts, []).length, 0);
  assert.equal(visibleFacts({ id: "est1", role: "estimator" }, facts, []).length, 2);
  assert.equal(visibleFacts({ id: "x", role: "csr" }, facts, []).length, 3);
  assert.equal(visibleFacts({ id: "a", role: "admin" }, facts, []).length, 3);
  assert.equal(visibleFacts({ id: "c", role: "crew_leader" }, facts, []).length, 0);
});

// ---------- end to end through buildReport ----------
const now = () => new Date("2026-10-14T17:00:00Z");
function world() {
  const s = new MemoryReportStore();
  s.facts = [
    won({ divisions: ["siding"], estimatorId: "est1", source: "phone", contractCents: 2_000_000 }),
    won({ divisions: ["roofing"], estimatorId: "est2", source: "website", contractCents: 3_000_000 }),
    fact({ divisions: ["roofing"], estimatorId: "est2", source: "phone" }),
  ];
  s.spend = [{ source: "phone", month: "2026-10", spendCents: 100_000 }];
  s.names = { est1: "Estimator One", est2: "Estimator Two" };
  s.pm.set("pm-roofing", ["roofing"]);
  const c = new MemoryCommissionStore();
  c.estimators = [{ id: "est1", fullName: "Estimator One", ownTruck: true, active: true }];
  c.addEarned("est1", 50_000, "2026-10-05");
  return { s, c };
}
const args = (name: string, by?: string) => ({ name, from: "2026-10-01", to: "2026-10-31", by });
const user = (id: string, role: Role) => ({ id, role });
const code = (p: Promise<unknown>) => p.then(() => "no error", (e: ReportError) => e.code);

test("buildReport: admin gets every report; sales total and commissions owed match the data", async () => {
  const { s, c } = world();
  const sl = await buildReport(s, c, user("a", "admin"), args("sales", "division"), now);
  assert.equal(sl.totals?.sales, 5_000_000);
  const owed = await buildReport(s, c, user("a", "admin"), args("commissions-owed"), now);
  assert.equal(owed.totals?.net, 50_000);
  const cost = await buildReport(s, c, user("a", "admin"), args("cost-per-lead"), now);
  assert.equal(cost.rows.find((r) => r.source === "Phone")?.cpl, 50_000);
  for (const name of ["close-rate", "install-days", "ar-aging", "deposits", "depreciation"]) {
    assert.ok(await buildReport(s, c, user("a", "admin"), args(name), now), name);
  }
  assert.equal((await buildReport(s, c, user("a", "admin"), args("install-days"), now)).emptyReason !== undefined, true);
});

test("buildReport: a PM only sees their division; an estimator only their own rows", async () => {
  const { s, c } = world();
  const pm = await buildReport(s, c, user("pm-roofing", "production_manager"), args("sales", "division"), now);
  assert.deepEqual(pm.rows.map((r) => r.group), ["Roofing"]);
  assert.equal(pm.totals?.sales, 3_000_000);
  const est = await buildReport(s, c, user("est1", "estimator"), args("sales", "estimator"), now);
  assert.deepEqual(est.rows.map((r) => r.group), ["Estimator One"]);
  assert.equal(est.totals?.sales, 2_000_000);
});

test("buildReport: a CSR gets counts by source and no dollar column anywhere", async () => {
  const { s, c } = world();
  const t = await buildReport(s, c, user("csr", "csr"), args("close-rate"), now);
  assert.ok(t.columns.every((col) => col.kind !== "money"));
  assert.equal(await code(buildReport(s, c, user("csr", "csr"), args("close-rate", "estimator"), now)), "invalid_group");
  assert.equal(await code(buildReport(s, c, user("csr", "csr"), args("sales", "division"), now)), "forbidden");
  assert.equal(await code(buildReport(s, c, user("csr", "csr"), args("cost-per-lead"), now)), "forbidden");
});

test("buildReport: other roles, unknown names, bad groupings and bad ranges are refused", async () => {
  const { s, c } = world();
  assert.equal(await code(buildReport(s, c, user("x", "crew_leader"), args("close-rate"), now)), "forbidden");
  assert.equal(await code(buildReport(s, c, user("e", "estimator"), args("commissions-owed"), now)), "forbidden");
  assert.equal(await code(buildReport(s, c, user("pm", "production_manager"), args("ar-aging"), now)), "forbidden");
  assert.equal(await code(buildReport(s, c, user("a", "admin"), args("nope"), now)), "unknown_report");
  assert.equal(await code(buildReport(s, c, user("a", "admin"), args("sales", "source"), now)), "invalid_group");
  assert.equal(await code(buildReport(s, c, user("a", "admin"), { name: "sales", from: "2026-10-31", to: "2026-10-01" }, now)), "invalid_range");
  assert.equal(await code(buildReport(s, c, user("a", "admin"), { name: "sales", from: "2024-01-01", to: "2026-10-01" }, now)), "invalid_range");
  assert.equal(await code(buildReport(s, c, user("a", "admin"), { name: "sales", from: "x", to: "2026-10-01" }, now)), "invalid_range");
  assert.equal(await code(buildReport(s, c, user("a", "admin"), { name: "sales", from: null, to: null }, now)), "invalid_range");
});

test("range presets resolve in Central time", () => {
  assert.deepEqual(presetRange("thisMonth", "2026-10-14"), { from: "2026-10-01", to: "2026-10-14" });
  assert.deepEqual(presetRange("lastMonth", "2026-10-14"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(presetRange("lastMonth", "2026-01-05"), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(presetRange("last90", "2026-10-14"), { from: "2026-07-17", to: "2026-10-14" });
  assert.deepEqual(presetRange("ytd", "2026-10-14"), { from: "2026-01-01", to: "2026-10-14" });
  assert.deepEqual(parseRange("2026-10-01", "2026-10-01"), { from: "2026-10-01", to: "2026-10-01" });
});
