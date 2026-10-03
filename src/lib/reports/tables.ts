import { en } from "../../i18n/en.ts";
import type { ArRow, CloseRateRow, CostRow, DepositRow, DepreciationRow, InstallRow, OwedRow, SalesRow } from "./calc.ts";
import type { ReportTable } from "./types.ts";

type Names = Record<string, string>;
const r = en.reports;

const labelFor = (by: "estimator" | "division" | "source", key: string, names: Names): string => {
  if (key === "unassigned") return r.unassigned;
  if (by === "estimator") return names[key] ?? key;
  if (by === "division") return (en.leads.divisionNames as Record<string, string>)[key] ?? key;
  return (en.leads.sources as Record<string, string>)[key] ?? key;
};
const groupLabel = (by: "estimator" | "division" | "source") => r.cols[by];

export function closeRateTable(res: { rows: CloseRateRow[]; total: CloseRateRow }, by: "estimator" | "division" | "source", names: Names): ReportTable {
  const row = (x: CloseRateRow, label: string) => ({
    group: label, leads: x.leads, won: x.won, lost: x.lost, open: x.open, closeRate: x.closeRateBps, decided: x.decidedRateBps,
  });
  return {
    name: "close-rate", title: `${r.names["close-rate"]}: ${r.by[by]}`,
    columns: [
      { key: "group", label: groupLabel(by), kind: "text" }, { key: "leads", label: r.cols.leads, kind: "int" },
      { key: "won", label: r.cols.won, kind: "int" }, { key: "lost", label: r.cols.lost, kind: "int" }, { key: "open", label: r.cols.open, kind: "int" },
      { key: "closeRate", label: r.cols.closeRate, kind: "percent" }, { key: "decided", label: r.cols.decidedRate, kind: "percent" },
    ],
    rows: res.rows.map((x) => row(x, labelFor(by, x.key, names))),
    totals: row(res.total, r.total),
    emptyReason: res.rows.length === 0 ? r.noData : undefined,
  };
}

export function salesTable(res: { rows: SalesRow[]; total: SalesRow }, by: "division" | "estimator", names: Names): ReportTable {
  const row = (x: SalesRow, label: string) => ({ group: label, jobs: x.jobs, sales: x.salesCents, average: x.averageCents });
  return {
    name: "sales", title: `${r.names.sales}: ${r.by[by]}`,
    columns: [
      { key: "group", label: groupLabel(by), kind: "text" }, { key: "jobs", label: r.cols.jobs, kind: "int" },
      { key: "sales", label: r.cols.sales, kind: "money" }, { key: "average", label: r.cols.average, kind: "money" },
    ],
    rows: res.rows.map((x) => row(x, labelFor(by, x.key, names))),
    totals: row(res.total, r.total),
    emptyReason: res.rows.length === 0 ? r.noData : undefined,
  };
}

export function costTable(res: { rows: CostRow[]; months: string[] }): ReportTable {
  return {
    name: "cost-per-lead", title: r.names["cost-per-lead"], note: r.wholeMonths,
    columns: [
      { key: "source", label: r.cols.source, kind: "text" }, { key: "leads", label: r.cols.leads, kind: "int" }, { key: "won", label: r.cols.won, kind: "int" },
      { key: "spend", label: r.cols.spend, kind: "money" }, { key: "cpl", label: r.cols.costPerLead, kind: "money" }, { key: "cpw", label: r.cols.costPerWin, kind: "money" },
    ],
    rows: res.rows.map((x) => ({ source: labelFor("source", x.source, {}), leads: x.leads, won: x.won, spend: x.spendCents, cpl: x.costPerLeadCents, cpw: x.costPerWinCents })),
    emptyReason: res.rows.length === 0 ? r.noData : undefined,
  };
}

export function installTable(res: { rows: InstallRow[]; total: InstallRow | null }): ReportTable {
  const row = (x: InstallRow, label: string) => ({ group: label, jobs: x.jobs, avg: x.averageDaysTenths, min: x.minDays, max: x.maxDays });
  return {
    name: "install-days", title: r.names["install-days"],
    columns: [
      { key: "group", label: r.cols.division, kind: "text" }, { key: "jobs", label: r.cols.jobs, kind: "int" },
      { key: "avg", label: r.cols.avgDays, kind: "days" }, { key: "min", label: r.cols.minDays, kind: "int" }, { key: "max", label: r.cols.maxDays, kind: "int" },
    ],
    rows: res.rows.map((x) => row(x, labelFor("division", x.key, {}))),
    totals: res.total ? row(res.total, r.total) : undefined,
    emptyReason: res.rows.length === 0 ? r.empty["install-days"] : undefined,
  };
}

export function arTable(res: { rows: ArRow[]; buckets: { bucket: string; jobs: number; totalCents: number }[]; totalCents: number }): ReportTable {
  return {
    name: "ar-aging", title: r.names["ar-aging"],
    columns: [
      { key: "job", label: r.cols.job, kind: "int" }, { key: "balance", label: r.cols.balance, kind: "money" },
      { key: "age", label: r.cols.age, kind: "int" }, { key: "bucket", label: r.cols.bucket, kind: "text" },
    ],
    rows: res.rows.map((x) => ({ job: x.jobNumber, balance: x.balanceCents, age: x.ageDays, bucket: x.bucket })),
    totals: { job: null, balance: res.totalCents, age: null, bucket: res.buckets.map((b) => `${b.bucket}: ${b.jobs}`).join(" | ") },
    emptyReason: res.rows.length === 0 ? r.empty["ar-aging"] : undefined,
  };
}

export function depositsTable(res: { rows: DepositRow[]; totalCents: number }): ReportTable {
  return {
    name: "deposits", title: r.names.deposits,
    columns: [{ key: "job", label: r.cols.job, kind: "int" }, { key: "due", label: r.cols.due, kind: "money" }, { key: "age", label: r.cols.age, kind: "int" }],
    rows: res.rows.map((x) => ({ job: x.jobNumber, due: x.dueCents, age: x.ageDays })),
    totals: { job: null, due: res.totalCents, age: null },
    emptyReason: res.rows.length === 0 ? r.empty.deposits : undefined,
  };
}

export function depreciationTable(res: { rows: DepreciationRow[]; totalCents: number }): ReportTable {
  return {
    name: "depreciation", title: r.names.depreciation,
    columns: [
      { key: "job", label: r.cols.job, kind: "int" }, { key: "carrier", label: r.cols.carrier, kind: "text" },
      { key: "claim", label: r.cols.claim, kind: "text" }, { key: "held", label: r.cols.held, kind: "money" },
    ],
    rows: res.rows.map((x) => ({ job: x.jobNumber, carrier: x.carrier, claim: x.claimNumber, held: x.heldCents })),
    totals: { job: null, carrier: null, claim: null, held: res.totalCents },
    emptyReason: res.rows.length === 0 ? r.empty.depreciation : undefined,
  };
}

export function owedTable(res: { rows: OwedRow[]; totalNetCents: number }): ReportTable {
  return {
    name: "commissions-owed", title: r.names["commissions-owed"],
    columns: [
      { key: "estimator", label: r.cols.estimator, kind: "text" }, { key: "unpaid", label: r.cols.unpaid, kind: "money" },
      { key: "draws", label: r.cols.draws, kind: "money" }, { key: "net", label: r.cols.net, kind: "money" },
    ],
    rows: res.rows.map((x) => ({ estimator: x.name, unpaid: x.unpaidCents, draws: x.drawsOutstandingCents, net: x.netPayableCents })),
    totals: { estimator: r.total, unpaid: null, draws: null, net: res.totalNetCents },
    emptyReason: res.rows.length === 0 ? r.empty["commissions-owed"] : undefined,
  };
}
