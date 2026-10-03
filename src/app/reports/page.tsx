import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getCommissionStore } from "@/lib/commission/index.ts";
import { localDate } from "@/lib/commission/periods.ts";
import { getReportStore } from "@/lib/reports/index.ts";
import { groupingsFor, reportsFor, type Grouping, type ReportName } from "@/lib/reports/access.ts";
import { ReportError, buildReport, parseRange, presetRange } from "@/lib/reports/logic.ts";
import type { ReportTable } from "@/lib/reports/types.ts";
import { en } from "@/i18n/en.ts";
import { ReportTableView } from "./report-table.tsx";

type SP = { preset?: string; from?: string; to?: string };
const PRESETS = ["thisMonth", "lastMonth", "last90", "ytd"] as const;

// Every signed-in role that has at least one report. buildReport decides what each role may see.
export default async function ReportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const names = reportsFor(user.role);
  if (names.length === 0) redirect("/");

  const sp = await searchParams;
  const today = localDate(new Date());
  let range = presetRange(PRESETS.includes(sp.preset as (typeof PRESETS)[number]) ? sp.preset! : "thisMonth", today);
  let rangeError = false;
  if (sp.from && sp.to) {
    try { range = parseRange(sp.from, sp.to); } catch { rangeError = true; }
  }

  type Task = { name: ReportName; by: Grouping | null };
  const tasks: Task[] = names.flatMap((name): Task[] => {
    const groups = groupingsFor(user.role, name);
    return groups.length ? groups.map((by): Task => ({ name, by })) : [{ name, by: null }];
  });
  const store = getReportStore(), commission = getCommissionStore();
  const built = await Promise.all(tasks.map(async (t): Promise<{ t: typeof t; table: ReportTable | null }> => {
    try {
      return { t, table: await buildReport(store, commission, user, { name: t.name, from: range.from, to: range.to, by: t.by }) };
    } catch (e) {
      if (e instanceof ReportError) return { t, table: null };
      throw e;
    }
  }));

  const csv = (t: { name: ReportName; by: Grouping | null }) =>
    `/api/reports/${t.name}?from=${range.from}&to=${range.to}${t.by ? `&by=${t.by}` : ""}&format=csv`;

  return (
    <>
      <p className="noprint"><Link href="/">{en.home.back}</Link></p>
      <h1>{en.reports.title}</h1>
      <p className="muted">{en.reports.rangeLine(range.from, range.to)}</p>

      <form method="get" className="row noprint">
        {PRESETS.map((p) => <button key={p} name="preset" value={p} type="submit" className="secondary small">{en.reports.presets[p]}</button>)}
        <label htmlFor="from">{en.reports.from}</label>
        <input id="from" name="from" type="date" defaultValue={range.from} />
        <label htmlFor="to">{en.reports.to}</label>
        <input id="to" name="to" type="date" defaultValue={range.to} />
        <button type="submit" className="small">{en.reports.apply}</button>
        <button type="button" className="secondary small" id="print-btn">{en.reports.print}</button>
      </form>
      {rangeError && <p className="error">{en.reports.errors.invalid_range}</p>}

      {built.map(({ t, table }) => table && <ReportTableView key={`${t.name}-${t.by}`} table={table} csvHref={csv(t)} />)}
      <script dangerouslySetInnerHTML={{ __html: "document.getElementById('print-btn')?.addEventListener('click',()=>window.print())" }} />
    </>
  );
}
