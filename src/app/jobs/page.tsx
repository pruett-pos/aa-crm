import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { canReadScopes } from "@/lib/scopes/service.ts";
import { canViewPayments } from "@/lib/payments/logic.ts";
import { hasRole } from "@/lib/auth/roles.ts";
import { STAGES } from "@/lib/rules.ts";
import { getWorkOrderStore } from "@/lib/workorders/index.ts";
import { en } from "@/i18n/en.ts";

export default async function JobsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!hasRole(user.role, ["admin", "estimator", "production_manager", "accounting"])) redirect("/");

  const store = getScopeStore();
  const all = await store.listJobs();
  // Signed jobs still waiting on colors, for the people who enter them (admin and the job's own estimator).
  const needingColors = new Map((await getWorkOrderStore().jobsNeedingColors()).map((n) => [n.jobId, n.missing]));
  const visible = [];
  for (const j of all) {
    const scopes = canReadScopes(user, j, await store.divisionManagerIds(j.divisions));
    const payments = canViewPayments(user, j);
    if (scopes || payments) visible.push({ j, scopes, payments });
  }

  return (
    <>
      <h1>{en.jobs.title}</h1>
      {visible.length === 0 ? (
        <p className="muted">{en.jobs.empty}</p>
      ) : (
        <ul className="list">
          {visible.map(({ j, scopes, payments }) => (
            <li key={j.id}>
              <strong>{en.jobs.number} {j.jobNumber}</strong>{" "}
              {needingColors.has(j.id) && (user.role === "admin" || (user.role === "estimator" && j.estimatorId === user.id)) && (
                <Link href={`/jobs/${j.id}/production`} className="warn">{en.jobs.colorsNeeded(needingColors.get(j.id) ?? 0)}</Link>
              )}{" "}
              <span className="muted">
                {en.jobs.types[j.jobType]} · {j.divisions.join(", ").replaceAll("_", " ")} · {j.stage.replaceAll("_", " ")}
              </span>{" "}
              {scopes && <Link href={`/jobs/${j.id}/scope`}>{en.jobs.openScope}</Link>}
              {scopes && payments && " · "}
              {payments && <Link href={`/jobs/${j.id}/payments`}>{en.payments.openPayments}</Link>}
              {(scopes || payments) && STAGES.indexOf(j.stage) >= STAGES.indexOf("closeout_punchlist") && (
                <>{" · "}<Link href={`/jobs/${j.id}/closeout`}>{en.closeout.openCloseout}</Link></>
              )}
              {scopes && STAGES.indexOf(j.stage) >= STAGES.indexOf("contract_signed") && (
                <>{(scopes || payments) && " · "}<Link href={`/jobs/${j.id}/production`}>{en.production.openProduction}</Link></>
              )}
            </li>
          ))}
        </ul>
      )}
      <p><Link href="/">{en.home.back}</Link></p>
    </>
  );
}
