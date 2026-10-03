import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { hasRole } from "@/lib/auth/roles.ts";
import { localDate, isDateString } from "@/lib/commission/periods.ts";
import { DIVISIONS } from "@/lib/leads/types.ts";
import { getProductionStore } from "@/lib/production/index.ts";
import { scheduleBoard, type BoardItem } from "@/lib/production/logic.ts";
import { en } from "@/i18n/en.ts";

type SP = { week?: string; division?: string; crew?: string };
const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** The Monday of the week a date falls in. */
function mondayOf(d: string): string {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(d, -((dow + 6) % 7));
}
const tradeName = (d: string) => (en.leads.divisionNames as Record<string, string>)[d] ?? d;

function Table({ items, withDate }: { items: BoardItem[]; withDate: boolean }) {
  return (
    <table className="lines">
      <thead>
        <tr>
          {withDate && <th>{en.production.colDate}</th>}<th>{en.production.colJob}</th><th>{en.production.colTrade}</th>
          <th>{en.production.colWhere}</th><th>{en.production.colCrew}</th><th>{en.production.colStatus}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={`${i.jobId}-${i.division}`}>
            {withDate && <td>{i.installDate ?? ""}</td>}
            <td><Link href={`/jobs/${i.jobId}/production`}>{i.jobNumber}</Link></td>
            <td>{tradeName(i.division)}</td>
            <td>{i.propertyAddress}{i.customerName ? <span className="muted small-text"> · {i.customerName}</span> : null}</td>
            <td>{i.crewLeaderName ?? <span className="muted">{en.production.noCrew}</span>}</td>
            <td>{en.production.status[i.status]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Admin, estimators (their own jobs), Production Managers (their trades), crew leaders (their assigned trades).
export default async function SchedulePage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!hasRole(user.role, ["admin", "estimator", "production_manager", "crew_leader"])) redirect("/");

  const sp = await searchParams;
  const today = localDate(new Date());
  const monday = mondayOf(sp.week && isDateString(sp.week) ? sp.week : today);
  const sunday = addDays(monday, 6);
  const division = (DIVISIONS as readonly string[]).includes(sp.division ?? "") ? sp.division! : "";
  const store = getProductionStore();
  const crewLeaders = user.role === "crew_leader" ? [] : await store.listCrewLeaders();
  const crew = crewLeaders.some((c) => c.id === sp.crew) ? sp.crew! : "";

  const board = await scheduleBoard(store, { id: user.id, role: user.role }, { from: monday, to: sunday }, { division, crewLeaderId: crew });
  const qs = (week: string) => `?week=${week}${division ? `&division=${division}` : ""}${crew ? `&crew=${crew}` : ""}`;

  return (
    <>
      <p className="noprint"><Link href="/">{en.home.back}</Link></p>
      <h1>{en.production.boardTitle}</h1>
      <p className="row noprint">
        <Link href={`/schedule${qs(addDays(monday, -7))}`}>{en.production.prevWeek}</Link>
        <Link href={`/schedule${qs(today)}`}>{en.production.thisWeek}</Link>
        <Link href={`/schedule${qs(addDays(monday, 7))}`}>{en.production.nextWeek}</Link>
      </p>
      <p className="muted">{en.production.week(monday, sunday)}</p>

      {user.role !== "crew_leader" && (
        <form method="get" className="row noprint">
          <input type="hidden" name="week" value={monday} />
          <label htmlFor="division">{en.production.filterTrade}</label>
          <select id="division" name="division" defaultValue={division}>
            <option value="">{en.production.allTrades}</option>
            {DIVISIONS.map((d) => <option key={d} value={d}>{tradeName(d)}</option>)}
          </select>
          <label htmlFor="crew">{en.production.filterCrew}</label>
          <select id="crew" name="crew" defaultValue={crew}>
            <option value="">{en.production.allCrews}</option>
            {crewLeaders.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
          </select>
          <button type="submit" className="small">{en.production.apply}</button>
        </form>
      )}

      {board.items.length === 0 ? <p className="muted">{en.production.nothingThisWeek}</p> : <Table items={board.items} withDate />}

      {user.role !== "crew_leader" && (
        <>
          <section className="report">
            <h2>{en.production.needsDate}</h2>
            {board.needsDate.length === 0 ? <p className="muted">{en.production.queueEmpty}</p> : <Table items={board.needsDate} withDate={false} />}
          </section>
          <section className="report">
            <h2>{en.production.needsCrew}</h2>
            {board.needsCrew.length === 0 ? <p className="muted">{en.production.queueEmpty}</p> : <Table items={board.needsCrew} withDate />}
          </section>
        </>
      )}
    </>
  );
}
