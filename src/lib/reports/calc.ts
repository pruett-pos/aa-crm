import { balanceDueCents, costPerCents, depositDueCents, netPayout, rateBps } from "../rules.ts";
import type { ClaimFact, CommissionBalance, DateRange, JobFact, SpendRow } from "./types.ts";

const inRange = (d: string | null, r: DateRange) => d !== null && d >= r.from && d <= r.to;
const primaryDivision = (f: JobFact) => f.divisions[0] ?? "unknown";
const UNASSIGNED = "unassigned";

/** Days between two local dates (b minus a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Calendar months a date range touches, as "YYYY-MM" from first to last. */
export function monthsTouched(r: DateRange): string[] {
  const out: string[] = [];
  let [y, m] = r.from.split("-").map(Number);
  const [ey, em] = r.to.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}
export function wholeMonthRange(r: DateRange): DateRange {
  const months = monthsTouched(r);
  const last = months[months.length - 1];
  const [y, m] = last.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${months[0]}-01`, to: `${last}-${String(lastDay).padStart(2, "0")}` };
}

// ---------- Close rate ----------
export type CloseRateRow = {
  key: string; leads: number; won: number; lost: number; open: number;
  closeRateBps: number;      // won / all leads (AL's definition)
  decidedRateBps: number;    // won / (won + lost), for reference
};

/** Leads created in the range (paid condition reports excluded), grouped. "Won" means a contract was ever signed. */
export function closeRate(facts: JobFact[], range: DateRange, by: "estimator" | "division" | "source"): { rows: CloseRateRow[]; total: CloseRateRow } {
  const keyOf = (f: JobFact) => (by === "estimator" ? f.estimatorId ?? UNASSIGNED : by === "division" ? primaryDivision(f) : f.source);
  const groups = new Map<string, JobFact[]>();
  for (const f of facts) {
    if (f.jobType === "condition_report" || !inRange(f.createdDate, range)) continue;
    const k = keyOf(f);
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const summarize = (key: string, fs: JobFact[]): CloseRateRow => {
    const won = fs.filter((f) => f.wonDate !== null).length;
    const lost = fs.filter((f) => f.wonDate === null && (f.stage === "lost" || f.stage === "cancelled_after_approval")).length;
    return {
      key, leads: fs.length, won, lost, open: fs.length - won - lost,
      closeRateBps: rateBps(won, fs.length), decidedRateBps: rateBps(won, won + lost),
    };
  };
  const rows = [...groups].map(([k, fs]) => summarize(k, fs)).sort((a, b) => b.leads - a.leads || a.key.localeCompare(b.key));
  return { rows, total: summarize("total", [...groups.values()].flat()) };
}

// ---------- Sales ----------
export type SalesRow = { key: string; jobs: number; salesCents: number; averageCents: number };

/** Contract totals of jobs whose contract was signed in the range. A multi-division job counts under its first division. */
export function sales(facts: JobFact[], range: DateRange, by: "division" | "estimator"): { rows: SalesRow[]; total: SalesRow } {
  const keyOf = (f: JobFact) => (by === "division" ? primaryDivision(f) : f.estimatorId ?? UNASSIGNED);
  const won = facts.filter((f) => f.jobType !== "condition_report" && inRange(f.wonDate, range) && f.contractCents !== null);
  const groups = new Map<string, JobFact[]>();
  for (const f of won) groups.set(keyOf(f), [...(groups.get(keyOf(f)) ?? []), f]);
  const summarize = (key: string, fs: JobFact[]): SalesRow => {
    const total = fs.reduce((s, f) => s + (f.contractCents ?? 0), 0);
    return { key, jobs: fs.length, salesCents: total, averageCents: fs.length ? Math.round(total / fs.length) : 0 };
  };
  const rows = [...groups].map(([k, fs]) => summarize(k, fs)).sort((a, b) => b.salesCents - a.salesCents || a.key.localeCompare(b.key));
  return { rows, total: summarize("total", won) };
}

// ---------- Cost per lead and per won job ----------
export type CostRow = {
  source: string; leads: number; won: number; spendCents: number | null;
  costPerLeadCents: number | null; costPerWinCents: number | null;
};

/** Works on whole calendar months, because ad spend is entered per month. */
export function costBySource(facts: JobFact[], spend: SpendRow[], range: DateRange): { rows: CostRow[]; months: string[] } {
  const whole = wholeMonthRange(range);
  const months = monthsTouched(range);
  const sources = new Set<string>();
  const leads = new Map<string, number>();
  const won = new Map<string, number>();
  for (const f of facts) {
    if (f.jobType === "condition_report" || !inRange(f.createdDate, whole)) continue;
    sources.add(f.source);
    leads.set(f.source, (leads.get(f.source) ?? 0) + 1);
    if (f.wonDate !== null) won.set(f.source, (won.get(f.source) ?? 0) + 1);
  }
  const spendBy = new Map<string, number>();
  for (const s of spend) {
    if (!months.includes(s.month)) continue;
    sources.add(s.source);
    spendBy.set(s.source, (spendBy.get(s.source) ?? 0) + s.spendCents);
  }
  const rows = [...sources].sort().map((source): CostRow => {
    const spendCents = spendBy.has(source) ? spendBy.get(source)! : null; // null = nothing entered
    const l = leads.get(source) ?? 0, w = won.get(source) ?? 0;
    return {
      source, leads: l, won: w, spendCents,
      costPerLeadCents: spendCents === null ? null : costPerCents(spendCents, l),
      costPerWinCents: spendCents === null ? null : costPerCents(spendCents, w),
    };
  });
  return { rows, months };
}

// ---------- Days from contract to install ----------
export type InstallRow = { key: string; jobs: number; averageDaysTenths: number; minDays: number; maxDays: number };

/** Won date to the day the job went into production (else its scheduled install date). Only jobs won in the range. */
export function installDays(facts: JobFact[], range: DateRange): { rows: InstallRow[]; total: InstallRow | null } {
  const samples: { key: string; days: number }[] = [];
  for (const f of facts) {
    if (!inRange(f.wonDate, range)) continue;
    const start = f.inProductionDate ?? f.installDate;
    if (!start || !f.wonDate) continue;
    samples.push({ key: primaryDivision(f), days: Math.max(0, daysBetween(f.wonDate, start)) });
  }
  const summarize = (key: string, xs: number[]): InstallRow => ({
    key, jobs: xs.length, averageDaysTenths: Math.round((xs.reduce((s, d) => s + d, 0) * 10) / xs.length),
    minDays: Math.min(...xs), maxDays: Math.max(...xs),
  });
  const groups = new Map<string, number[]>();
  for (const s of samples) groups.set(s.key, [...(groups.get(s.key) ?? []), s.days]);
  const rows = [...groups].map(([k, xs]) => summarize(k, xs)).sort((a, b) => a.key.localeCompare(b.key));
  return { rows, total: samples.length ? summarize("total", samples.map((s) => s.days)) : null };
}

// ---------- AR aging ----------
export const AR_BUCKETS = ["0-30", "31-60", "61-90", "91+"] as const;
export type ArBucket = (typeof AR_BUCKETS)[number];
export const arBucketFor = (ageDays: number): ArBucket => (ageDays <= 30 ? "0-30" : ageDays <= 60 ? "31-60" : ageDays <= 90 ? "61-90" : "91+");

export type ArRow = { jobId: string; jobNumber: number; balanceCents: number; ageDays: number; bucket: ArBucket };

/** Balance due on invoiced jobs not yet paid in full, aged from the day the job was invoiced. */
export function arAging(facts: JobFact[], today: string): { rows: ArRow[]; buckets: { bucket: ArBucket; jobs: number; totalCents: number }[]; totalCents: number } {
  const rows: ArRow[] = [];
  for (const f of facts) {
    if (f.stage !== "invoiced" && f.stage !== "depreciation_pending") continue;
    const balance = balanceDueCents(f.contractCents ?? 0, f.collectedCents);
    if (balance <= 0) continue;
    const ageDays = Math.max(0, daysBetween(f.invoicedDate ?? f.createdDate, today));
    rows.push({ jobId: f.jobId, jobNumber: f.jobNumber, balanceCents: balance, ageDays, bucket: arBucketFor(ageDays) });
  }
  rows.sort((a, b) => b.ageDays - a.ageDays);
  const buckets = AR_BUCKETS.map((bucket) => {
    const rs = rows.filter((r) => r.bucket === bucket);
    return { bucket, jobs: rs.length, totalCents: rs.reduce((s, r) => s + r.balanceCents, 0) };
  });
  return { rows, buckets, totalCents: rows.reduce((s, r) => s + r.balanceCents, 0) };
}

// ---------- Deposits outstanding ----------
export type DepositRow = { jobId: string; jobNumber: number; dueCents: number; ageDays: number };

/** Jobs with a signed contract whose required deposit isn't covered yet, aged from the signing date. */
export function depositsOutstanding(facts: JobFact[], today: string): { rows: DepositRow[]; totalCents: number } {
  const rows: DepositRow[] = [];
  for (const f of facts) {
    if (f.stage !== "contract_signed" || f.depositRequiredCents <= 0) continue;
    const due = depositDueCents(f.depositRequiredCents, f.depositPaidCents);
    if (due <= 0) continue;
    rows.push({ jobId: f.jobId, jobNumber: f.jobNumber, dueCents: due, ageDays: Math.max(0, daysBetween(f.wonDate ?? f.createdDate, today)) });
  }
  rows.sort((a, b) => b.ageDays - a.ageDays);
  return { rows, totalCents: rows.reduce((s, r) => s + r.dueCents, 0) };
}

// ---------- Outstanding depreciation ----------
export type DepreciationRow = { jobId: string; jobNumber: number; carrier: string | null; claimNumber: string | null; heldCents: number };

export function depreciationOutstanding(claims: ClaimFact[]): { rows: DepreciationRow[]; totalCents: number } {
  const rows = claims
    .filter((c) => c.depreciationCents > 0 && c.depreciationReceivedAt === null)
    .map((c) => ({ jobId: c.jobId, jobNumber: c.jobNumber, carrier: c.carrier, claimNumber: c.claimNumber, heldCents: c.depreciationCents }))
    .sort((a, b) => b.heldCents - a.heldCents);
  return { rows, totalCents: rows.reduce((s, r) => s + r.heldCents, 0) };
}

// ---------- Commissions owed ----------
export type OwedRow = { estimatorId: string; name: string; unpaidCents: number; drawsOutstandingCents: number; netPayableCents: number };

export function commissionsOwed(balances: CommissionBalance[]): { rows: OwedRow[]; totalNetCents: number } {
  const rows = balances
    .filter((b) => b.unpaidCents !== 0 || b.drawsOutstandingCents !== 0)
    .map((b) => ({ ...b, netPayableCents: netPayout(b.unpaidCents, b.drawsOutstandingCents).payCents }))
    .sort((a, b) => b.netPayableCents - a.netPayableCents || a.name.localeCompare(b.name));
  return { rows, totalNetCents: rows.reduce((s, r) => s + r.netPayableCents, 0) };
}
