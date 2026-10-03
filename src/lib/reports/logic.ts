import type { AuthUser } from "../auth/store.ts";
import { localDate } from "../commission/periods.ts";
import type { CommissionStore } from "../commission/types.ts";
import { isDateString } from "../commission/periods.ts";
import {
  arAging, closeRate, commissionsOwed, costBySource, depositsOutstanding, depreciationOutstanding, installDays, monthsTouched, sales,
  wholeMonthRange,
} from "./calc.ts";
import { REPORT_NAMES, canSeeReport, groupingsFor, visibleFacts, type Grouping, type ReportName } from "./access.ts";
import { arTable, closeRateTable, costTable, depositsTable, depreciationTable, installTable, owedTable, salesTable } from "./tables.ts";
import type { CommissionBalance, DateRange, ReportStore, ReportTable } from "./types.ts";

export type ReportErrorCode = "invalid_range" | "invalid_group" | "unknown_report" | "forbidden";
export class ReportError extends Error {
  code: ReportErrorCode;
  constructor(code: ReportErrorCode) {
    super(code);
    this.code = code;
  }
}

const MAX_SPAN_DAYS = 731;

export function parseRange(from: string | null, to: string | null): DateRange {
  if (!from || !to || !isDateString(from) || !isDateString(to) || from > to) throw new ReportError("invalid_range");
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (span > MAX_SPAN_DAYS) throw new ReportError("invalid_range");
  return { from, to };
}

/** The quick ranges on the reports page, resolved in Central time. */
export function presetRange(preset: string, today: string): DateRange {
  const [y, m] = today.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  if (preset === "lastMonth") {
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    return { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(lastDay(py, pm))}` };
  }
  if (preset === "last90") {
    const start = new Date(Date.parse(`${today}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10);
    return { from: start, to: today };
  }
  if (preset === "ytd") return { from: `${y}-01-01`, to: today };
  return { from: `${y}-${pad(m)}-01`, to: today }; // this month
}

export async function commissionBalances(store: CommissionStore): Promise<CommissionBalance[]> {
  const out: CommissionBalance[] = [];
  for (const e of await store.listEstimators()) {
    const [unpaid, draws] = await Promise.all([store.unpaidThrough(e.id, "9999-12-31"), store.listDraws(e.id)]);
    out.push({ estimatorId: e.id, name: e.fullName, unpaidCents: unpaid, drawsOutstandingCents: draws.reduce((s, d) => s + (d.amountCents - d.appliedCents), 0) });
  }
  return out;
}

export type BuildArgs = { name: string; from: string | null; to: string | null; by?: string | null };

/** Build one report for a user. Enforces who may see it, which grouping, and which rows. */
export async function buildReport(
  store: ReportStore, commission: CommissionStore, user: Pick<AuthUser, "id" | "role">, args: BuildArgs, now: () => Date = () => new Date(),
): Promise<ReportTable> {
  if (!(REPORT_NAMES as readonly string[]).includes(args.name)) throw new ReportError("unknown_report");
  const name = args.name as ReportName;
  if (!canSeeReport(user.role, name)) throw new ReportError("forbidden");
  const range = parseRange(args.from, args.to);
  const today = localDate(now());

  const pmDivisions = user.role === "production_manager" ? await store.pmDivisions(user.id) : [];
  const facts = visibleFacts(user, await store.listJobFacts(), pmDivisions);
  const names = await store.estimatorNames();

  const allowed = groupingsFor(user.role, name);
  const by = (args.by ?? allowed[0] ?? null) as Grouping | null;
  if (allowed.length > 0 && (!by || !allowed.includes(by))) throw new ReportError("invalid_group");

  switch (name) {
    case "close-rate": return closeRateTable(closeRate(facts, range, by as Grouping), by as Grouping, names);
    case "sales": return salesTable(sales(facts, range, by as "division" | "estimator"), by as "division" | "estimator", names);
    case "cost-per-lead": {
      const months = monthsTouched(range);
      const spend = await store.listSpend(months[0], months[months.length - 1]);
      return costTable(costBySource(facts, spend, range));
    }
    case "install-days": return installTable(installDays(facts, range));
    case "ar-aging": return arTable(arAging(facts, today));
    case "deposits": return depositsTable(depositsOutstanding(facts, today));
    case "depreciation": return depreciationTable(depreciationOutstanding(await store.listClaims()));
    case "commissions-owed": return owedTable(commissionsOwed(await commissionBalances(commission)));
  }
}

export { wholeMonthRange };
