import {
  allocateDraws, commissionEarnedCents, commissionRateBps, grossMarginBps, netPayout, parseDollarsToCents,
} from "../rules.ts";
import type { Role } from "../auth/roles.ts";
import type { AuthUser } from "../auth/store.ts";
import {
  CADENCES, ScheduleError, closedPeriods, isDateString, isPeriodEnd, localDate, periodContaining, validateSchedule,
  type Period, type Schedule,
} from "./periods.ts";
import type { CommissionStore, Draw, LedgerEntry, NewEntry, Run } from "./types.ts";

export type CommissionErrorCode =
  | "not_found" | "forbidden" | "no_schedule" | "schedule_invalid" | "period_invalid" | "period_open" | "already_paid"
  | "nothing_to_pay" | "amount_invalid" | "date_invalid" | "reason_required" | "estimator_invalid";

export class CommissionError extends Error {
  code: CommissionErrorCode;
  constructor(code: CommissionErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

// ---------- Who may do what ----------
/** Admin and accounting see every statement; an estimator sees only their own. Nobody else sees any. */
export function canViewStatement(user: Pick<AuthUser, "id" | "role">, estimatorId: string): boolean {
  if (user.role === "admin" || user.role === "accounting") return true;
  return user.role === "estimator" && user.id === estimatorId;
}
export const canManagePayouts = (role: Role) => role === "admin" || role === "accounting";
export const canAdjust = (role: Role) => role === "admin";
export const canSetSchedule = (role: Role) => role === "admin";

// ---------- Accrual (called from the payments transaction) ----------
/**
 * The commission entry for one collected payment: rate and margin are snapshotted from the job
 * (own-truck at that moment). Returns null when there is no estimator or the margin isn't known yet.
 */
export function buildAccrual(
  job: { id: string; estimatorId: string | null; estimatorOwnTruck: boolean; contractCents: number | null; costCents: number | null },
  payment: { id: string; amountCents: number }, entryDate: string,
): NewEntry | null {
  if (!job.estimatorId || !job.contractCents || job.costCents === null) return null;
  const marginBps = grossMarginBps(job.contractCents, job.costCents);
  return {
    estimatorId: job.estimatorId, jobId: job.id, paymentId: payment.id, kind: "earned",
    rateBps: commissionRateBps(marginBps, job.estimatorOwnTruck), marginBps,
    amountCents: commissionEarnedCents(payment.amountCents, marginBps, job.estimatorOwnTruck), entryDate, note: null,
  };
}

// ---------- Schedule ----------
export async function setSchedule(store: CommissionStore, a: { cadence: string; anchorDate: string | null; userId: string }) {
  const s = { cadence: a.cadence, anchorDate: a.anchorDate || null } as Schedule;
  if (!(CADENCES as readonly string[]).includes(a.cadence)) throw new CommissionError("schedule_invalid");
  try {
    validateSchedule(s);
  } catch (e) {
    if (e instanceof ScheduleError) throw new CommissionError("schedule_invalid", e.message);
    throw e;
  }
  const keepsAnchor = s.cadence === "weekly" || s.cadence === "biweekly";
  const clean: Schedule = { cadence: s.cadence, anchorDate: keepsAnchor ? s.anchorDate : null };
  await store.setSchedule(clean, a.userId);
  return clean;
}

// ---------- Draws and adjustments ----------
async function requireEstimator(store: CommissionStore, id: string) {
  const e = await store.getEstimator(id);
  if (!e) throw new CommissionError("estimator_invalid", "Choose an estimator");
  return e;
}

export async function recordDraw(
  store: CommissionStore, a: { actorId: string; estimatorId: string; amountText: string; paidOn?: string; note?: string }, now: () => Date = () => new Date(),
): Promise<Draw> {
  await requireEstimator(store, a.estimatorId);
  const cents = parseDollarsToCents(a.amountText);
  if (cents === null) throw new CommissionError("amount_invalid");
  const today = localDate(now());
  const paidOn = a.paidOn || today;
  if (!isDateString(paidOn) || paidOn > today || paidOn < shiftYears(today, -1)) throw new CommissionError("date_invalid");
  return store.transaction(a.estimatorId, (tx) =>
    tx.insertDraw({ estimatorId: a.estimatorId, amountCents: cents, paidOn, note: a.note?.trim().slice(0, 300) || null }, a.actorId));
}

export async function addAdjustment(
  store: CommissionStore, a: { actorId: string; estimatorId: string; amountText: string; reason: string }, now: () => Date = () => new Date(),
): Promise<LedgerEntry> {
  await requireEstimator(store, a.estimatorId);
  const text = a.amountText.trim();
  const negative = text.startsWith("-");
  const cents = parseDollarsToCents(negative ? text.slice(1) : text);
  if (cents === null) throw new CommissionError("amount_invalid");
  const reason = a.reason.trim();
  if (reason.length < 3 || reason.length > 300) throw new CommissionError("reason_required");
  return store.transaction(a.estimatorId, (tx) => tx.insertAdjustment({
    estimatorId: a.estimatorId, jobId: null, paymentId: null, kind: "adjustment", rateBps: null, marginBps: null,
    amountCents: negative ? -cents : cents, entryDate: localDate(now()), note: reason,
  }, a.actorId));
}

function shiftYears(date: string, years: number): string {
  return `${Number(date.slice(0, 4)) + years}${date.slice(4)}`;
}

// ---------- Payout runs ----------
export type PayoutResult = { run: Run; entriesPaid: number };

export async function runPayout(
  store: CommissionStore, a: { actorId: string; estimatorId: string; periodEnd: string; note?: string }, now: () => Date = () => new Date(),
): Promise<PayoutResult> {
  const schedule = await store.getSchedule();
  if (!schedule) throw new CommissionError("no_schedule", "Set the pay schedule first");
  await requireEstimator(store, a.estimatorId);
  if (!isPeriodEnd(a.periodEnd, schedule)) throw new CommissionError("period_invalid", "That is not the last day of a pay period");
  const today = localDate(now());
  if (a.periodEnd >= today) throw new CommissionError("period_open", "That pay period isn't over yet");
  const period = periodContaining(a.periodEnd, schedule);

  return store.transaction(a.estimatorId, async (tx) => {
    if (await tx.hasRun(period.end)) throw new CommissionError("already_paid", "This period was already paid for this estimator");
    const entries = await tx.unpaidEntries(period.end);
    const gross = entries.reduce((s, e) => s + e.amountCents, 0);
    if (gross <= 0) throw new CommissionError("nothing_to_pay", "Nothing to pay; any balance carries forward");

    const draws = await tx.outstandingDraws();
    const outstanding = draws.map((d) => ({ id: d.id, outstandingCents: d.amountCents - d.appliedCents }));
    const { payCents, drawsAppliedCents } = netPayout(gross, outstanding.reduce((s, d) => s + d.outstandingCents, 0));
    const applications = allocateDraws(outstanding, drawsAppliedCents).map((x) => ({ drawId: x.id, amountCents: x.amountCents }));

    const run = await tx.createRun(
      { estimatorId: a.estimatorId, periodStart: period.start, periodEnd: period.end, grossCents: gross,
        drawsAppliedCents, netCents: payCents, paidOn: today, note: a.note?.trim().slice(0, 300) || null },
      entries.map((e) => e.id), applications, a.actorId,
    );
    return { run, entriesPaid: entries.length };
  });
}

// ---------- Statements ----------
export type Statement = {
  estimator: { id: string; fullName: string };
  schedule: Schedule | null;
  currentPeriod: Period | null;
  earnedThisPeriodCents: number;
  unpaidCents: number;
  drawsOutstandingCents: number;
  netIfPaidTodayCents: number;
  entries: LedgerEntry[];
  draws: Draw[];
  runs: Run[];
};

export async function statement(store: CommissionStore, estimatorId: string, now: () => Date = () => new Date()): Promise<Statement> {
  const estimator = await store.getEstimator(estimatorId);
  if (!estimator) throw new CommissionError("not_found");
  const [schedule, entries, draws, runs] = await Promise.all([
    store.getSchedule(), store.listEntries(estimatorId, 300), store.listDraws(estimatorId), store.listRuns(estimatorId),
  ]);
  const today = localDate(now());
  const currentPeriod = schedule ? periodContaining(today, schedule) : null;
  const unpaidCents = entries.filter((e) => !e.runId).reduce((s, e) => s + e.amountCents, 0);
  const drawsOutstandingCents = draws.reduce((s, d) => s + (d.amountCents - d.appliedCents), 0);
  const earnedThisPeriodCents = currentPeriod
    ? entries.filter((e) => e.entryDate >= currentPeriod.start && e.entryDate <= currentPeriod.end).reduce((s, e) => s + e.amountCents, 0)
    : 0;
  return {
    estimator: { id: estimator.id, fullName: estimator.fullName }, schedule, currentPeriod, earnedThisPeriodCents,
    unpaidCents, drawsOutstandingCents, netIfPaidTodayCents: netPayout(unpaidCents, drawsOutstandingCents).payCents,
    entries, draws, runs,
  };
}

// ---------- Payout overview (accounting and admin) ----------
export type PayoutRow = {
  estimatorId: string; estimatorName: string; period: Period;
  unpaidThroughCents: number; drawsOutstandingCents: number; netCents: number;
  alreadyPaid: boolean; canPay: boolean;
};
export type PayoutOverview = { schedule: Schedule | null; rows: PayoutRow[]; uncommissionedPayments: number };

export async function payoutOverview(store: CommissionStore, now: () => Date = () => new Date()): Promise<PayoutOverview> {
  const schedule = await store.getSchedule();
  const uncommissionedPayments = await store.uncommissionedPaymentCount();
  if (!schedule) return { schedule: null, rows: [], uncommissionedPayments };
  const period = closedPeriods(localDate(now()), schedule, 1)[0];
  const rows: PayoutRow[] = [];
  for (const e of await store.listEstimators()) {
    const [unpaid, draws, runs] = await Promise.all([store.unpaidThrough(e.id, period.end), store.listDraws(e.id), store.listRuns(e.id)]);
    const drawsOutstandingCents = draws.reduce((s, d) => s + (d.amountCents - d.appliedCents), 0);
    const alreadyPaid = runs.some((r) => r.periodEnd === period.end);
    const { payCents } = netPayout(unpaid, drawsOutstandingCents);
    rows.push({
      estimatorId: e.id, estimatorName: e.fullName, period, unpaidThroughCents: unpaid, drawsOutstandingCents,
      netCents: payCents, alreadyPaid, canPay: !alreadyPaid && unpaid > 0,
    });
  }
  return { schedule, rows, uncommissionedPayments };
}
