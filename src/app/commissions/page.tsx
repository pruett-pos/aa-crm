import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { hasRole } from "@/lib/auth/roles.ts";
import { getCommissionStore } from "@/lib/commission/index.ts";
import { canManagePayouts, canViewStatement, statement } from "@/lib/commission/logic.ts";
import { en } from "@/i18n/en.ts";

const money = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

// An estimator sees only their own statement. Admin and accounting can pick any estimator.
export default async function CommissionsPage({ searchParams }: { searchParams: Promise<{ estimator?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!hasRole(user.role, ["estimator", "admin", "accounting"])) redirect("/");

  const store = getCommissionStore();
  const estimators = user.role === "estimator" ? [] : await store.listEstimators();
  const { estimator } = await searchParams;
  const targetId = user.role === "estimator" ? user.id : (estimator ?? estimators[0]?.id);
  if (!targetId) return <p className="muted">{en.commission.noEntries}</p>;
  if (!canViewStatement(user, targetId)) redirect("/");
  const st = await statement(store, targetId);

  return (
    <>
      <p><Link href="/">{en.home.back}</Link>{canManagePayouts(user.role) && <> · <Link href="/commissions/payouts">{en.commission.navPayouts}</Link></>}</p>
      <h1>{user.role === "estimator" ? en.commission.statementTitle : en.commission.statementFor(st.estimator.fullName)}</h1>

      {estimators.length > 0 && (
        <form method="get" className="row">
          <label htmlFor="estimator">{en.commission.pickEstimator}</label>
          <select id="estimator" name="estimator" defaultValue={targetId}>
            {estimators.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
          </select>
          <button type="submit" className="secondary small">OK</button>
        </form>
      )}

      {st.currentPeriod ? (
        <p className="muted">{en.commission.periodLabel(st.currentPeriod.start, st.currentPeriod.end)}</p>
      ) : (
        <p className="muted">{en.commission.noSchedule}</p>
      )}

      <div className="panel">
        <dl>
          {st.currentPeriod && <div><dt>{en.commission.thisPeriod}</dt><dd>{money(st.earnedThisPeriodCents)}</dd></div>}
          <div><dt>{en.commission.unpaid}</dt><dd>{money(st.unpaidCents)}</dd></div>
          <div><dt>{en.commission.drawsOutstanding}</dt><dd>{money(st.drawsOutstandingCents)}</dd></div>
          <div><dt>{en.commission.netIfPaid}</dt><dd>{money(st.netIfPaidTodayCents)}</dd></div>
        </dl>
      </div>

      <h2>{en.commission.entriesTitle}</h2>
      {st.entries.length === 0 ? <p className="muted">{en.commission.noEntries}</p> : (
        <table className="lines">
          <thead>
            <tr><th>{en.commission.colDate}</th><th>{en.commission.colJob}</th><th>{en.commission.colKind}</th><th>{en.commission.colRate}</th><th>{en.commission.colAmount}</th><th>{en.commission.colStatus}</th></tr>
          </thead>
          <tbody>
            {st.entries.map((e) => (
              <tr key={e.id}>
                <td>{e.entryDate}</td>
                <td>{e.jobNumber ?? ""}</td>
                <td>{en.commission.kinds[e.kind]}{e.note ? <span className="muted small-text"> · {e.note}</span> : null}</td>
                <td>{e.rateBps !== null ? `${(e.rateBps / 100).toFixed(1)}%` : ""}</td>
                <td className={e.amountCents < 0 ? "warn" : ""}>{money(e.amountCents)}</td>
                <td>{e.paidOn ? en.commission.paidStatus(e.paidOn) : en.commission.unpaidStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>{en.commission.drawsTitle}</h2>
      {st.draws.length === 0 ? <p className="muted">{en.commission.noDraws}</p> : (
        <table className="lines">
          <thead><tr><th>{en.commission.drawColDate}</th><th>{en.commission.drawColAmount}</th><th>{en.commission.drawColUsed}</th><th>{en.commission.drawColNote}</th></tr></thead>
          <tbody>
            {st.draws.map((d) => (
              <tr key={d.id}><td>{d.paidOn}</td><td>{money(d.amountCents)}</td><td>{money(d.appliedCents)}</td><td>{d.note ?? ""}</td></tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>{en.commission.runsTitle}</h2>
      {st.runs.length === 0 ? <p className="muted">{en.commission.noRuns}</p> : (
        <table className="lines">
          <thead>
            <tr><th>{en.commission.runColPeriod}</th><th>{en.commission.runColGross}</th><th>{en.commission.runColDraws}</th><th>{en.commission.runColNet}</th><th>{en.commission.runColDate}</th></tr>
          </thead>
          <tbody>
            {st.runs.map((r) => (
              <tr key={r.id}>
                <td>{r.periodStart} to {r.periodEnd}</td><td>{money(r.grossCents)}</td>
                <td>{money(r.drawsAppliedCents)}</td><td>{money(r.netCents)}</td><td>{r.paidOn}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
