import type { ReportTable } from "./types.ts";

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (starting with = + - @ or a tab/CR)
 * gets a leading apostrophe, so a customer or carrier name can't execute anything when opened in Excel.
 * Numbers are written as plain numbers (a negative number is not text, so it is left alone).
 */
export function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const fmt = (kind: string, v: string | number | null): string | number | null => {
  if (v === null || typeof v === "string") return v;
  if (kind === "money") return (v / 100).toFixed(2);       // cents -> dollars
  if (kind === "percent") return (v / 100).toFixed(1);     // basis points -> percent
  if (kind === "days") return (v / 10).toFixed(1);         // tenths -> days (average days)
  return v;
};

/** The table as CSV with a header row; money in dollars, percents as numbers like 42.5. */
export function toCsv(t: ReportTable): string {
  const lines = [t.columns.map((c) => csvCell(c.label)).join(",")];
  for (const row of [...t.rows, ...(t.totals ? [t.totals] : [])]) {
    lines.push(t.columns.map((c) => {
      const v = fmt(c.kind, row[c.key] ?? null);
      // numbers formatted to a fixed string are safe plain numerics, not text
      return typeof v === "string" && (c.kind === "money" || c.kind === "percent" || c.kind === "days") ? v : csvCell(v);
    }).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
