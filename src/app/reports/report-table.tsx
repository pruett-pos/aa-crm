import { en } from "@/i18n/en.ts";
import type { ColumnKind, ReportTable } from "@/lib/reports/types.ts";

const money = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

function format(kind: ColumnKind, v: string | number | null): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (kind === "money") return money(v);
  if (kind === "percent") return `${(v / 100).toFixed(1)}%`;
  if (kind === "days") return (v / 10).toFixed(1);
  return String(v);
}
const alignRight = (kind: ColumnKind) => kind !== "text";

export function ReportTableView({ table, csvHref }: { table: ReportTable; csvHref: string }) {
  return (
    <section className="report">
      <div className="report-head">
        <h2>{table.title}</h2>
        <a className="noprint small-text" href={csvHref}>{en.reports.csv}</a>
      </div>
      {table.note && <p className="muted small-text">{table.note}</p>}
      {table.emptyReason ? (
        <p className="muted">{table.emptyReason}</p>
      ) : (
        <table className="lines report-table">
          <thead>
            <tr>{table.columns.map((c) => <th key={c.key} className={alignRight(c.kind) ? "num" : ""}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i}>
                {table.columns.map((c) => {
                  const v = row[c.key] ?? null;
                  const notEntered = v === null && (c.key === "spend" || c.key === "cpl" || c.key === "cpw");
                  return <td key={c.key} className={alignRight(c.kind) ? "num" : ""}>{notEntered ? <span className="muted">{en.reports.notEntered}</span> : format(c.kind, v)}</td>;
                })}
              </tr>
            ))}
          </tbody>
          {table.totals && (
            <tfoot>
              <tr>{table.columns.map((c) => <td key={c.key} className={alignRight(c.kind) ? "num" : ""}><strong>{format(c.kind, table.totals![c.key] ?? null)}</strong></td>)}</tr>
            </tfoot>
          )}
        </table>
      )}
    </section>
  );
}
