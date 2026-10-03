import { isDateString } from "../commission/periods.ts";
import { daysBetween } from "../reports/calc.ts";

export type InstallDateProblem = "invalid" | "in_the_past" | "too_far_ahead";

/** An install date must be a real calendar date, not before today (Central time), and within a year. */
export function checkInstallDate(date: string, today: string): InstallDateProblem | null {
  if (!isDateString(date)) return "invalid";
  if (date < today) return "in_the_past";
  if (daysBetween(today, date) > 366) return "too_far_ahead";
  return null;
}
