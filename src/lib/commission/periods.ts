// Pay periods. A "date" here is a plain local calendar date, "YYYY-MM-DD", in the company time zone.

export const COMPANY_TZ = "America/Chicago";
export type Cadence = "weekly" | "biweekly" | "semimonthly" | "monthly";
export const CADENCES: readonly Cadence[] = ["weekly", "biweekly", "semimonthly", "monthly"];

/** For weekly and biweekly, `anchorDate` is any date a period ENDS on. Semimonthly and monthly ignore it. */
export type Schedule = { cadence: Cadence; anchorDate: string | null };
export type Period = { start: string; end: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isDateString = (s: string) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && fromDay(toDay(s)) === s;

const DAY_MS = 86_400_000;
function toDay(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}
function fromDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

/** The local calendar date a moment falls on in the company time zone. */
export function localDate(at: Date, tz: string = COMPANY_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export class ScheduleError extends Error {}

export function validateSchedule(s: Schedule): void {
  if (!CADENCES.includes(s.cadence)) throw new ScheduleError("Unknown cadence");
  if ((s.cadence === "weekly" || s.cadence === "biweekly") && !(s.anchorDate && isDateString(s.anchorDate))) {
    throw new ScheduleError("Weekly and every-other-week schedules need an anchor date");
  }
}

/** The pay period that contains a date. */
export function periodContaining(date: string, s: Schedule): Period {
  validateSchedule(s);
  if (!isDateString(date)) throw new ScheduleError("Bad date");
  const day = toDay(date);
  if (s.cadence === "weekly" || s.cadence === "biweekly") {
    const len = s.cadence === "weekly" ? 7 : 14;
    const anchor = toDay(s.anchorDate!);
    const end = anchor + Math.ceil((day - anchor) / len) * len;
    return { start: fromDay(end - len + 1), end: fromDay(end) };
  }
  const [y, m, d] = date.split("-").map(Number);
  const mm = String(m).padStart(2, "0");
  if (s.cadence === "monthly") return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${lastDayOfMonth(y, m)}` };
  return d <= 15
    ? { start: `${y}-${mm}-01`, end: `${y}-${mm}-15` }
    : { start: `${y}-${mm}-16`, end: `${y}-${mm}-${lastDayOfMonth(y, m)}` };
}

/** A period is closed once its last day has passed. */
export const isClosed = (p: Period, today: string) => p.end < today;

/** Closed periods, newest first, going back `count` periods from today. */
export function closedPeriods(today: string, s: Schedule, count: number): Period[] {
  const out: Period[] = [];
  let cursor = periodContaining(today, s);
  for (let i = 0; i < count; i++) {
    cursor = periodContaining(fromDay(toDay(cursor.start) - 1), s);
    out.push(cursor);
  }
  return out;
}

/** True if `end` is exactly the last day of one of this schedule's periods. */
export function isPeriodEnd(end: string, s: Schedule): boolean {
  return isDateString(end) && periodContaining(end, s).end === end;
}
