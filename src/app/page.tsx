import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { can, hasRole } from "@/lib/auth/roles.ts";
import { canTakeLeads } from "@/lib/leads/logic.ts";
import { canManagePayouts } from "@/lib/commission/logic.ts";
import { reportsFor } from "@/lib/reports/access.ts";
import { en } from "@/i18n/en.ts";
import { SignOutButton } from "./sign-out-button.tsx";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Placeholder links by capability; real pages arrive in later slices.
  const areas = [
    can(user.role, "buildScopes") && "Scopes of work",
    can(user.role, "viewAllJobs") && "All jobs",
    can(user.role, "scheduleCrews") && "Production schedule",
    can(user.role, "manageInvoicesAndPayments") && "Invoices and payments",
    can(user.role, "manageUsers") && "Users",
  ].filter(Boolean) as string[];

  return (
    <>
      <h1>{en.home.greeting(user.fullName)}</h1>
      <p>
        {en.home.roleLabel}: <span className="badge">{en.roles[user.role]}</span>
      </p>
      {reportsFor(user.role).length > 0 && <p><Link href="/reports">{en.reports.navLabel}</Link></p>}
      {hasRole(user.role, ["admin", "estimator", "production_manager", "crew_leader"]) && (
        <p><Link href="/schedule">{en.production.navSchedule}</Link></p>
      )}
      {canTakeLeads(user.role) && (
        <ul>
          <li><Link href="/leads/new">{en.leads.navNew}</Link></li>
          <li><Link href="/leads">{en.leads.navList}</Link></li>
          <li><Link href="/leads/review">{en.leads.navReview}</Link></li>
          {user.role === "admin" && <li><Link href="/settings/marketing">{en.leads.navMarketing}</Link></li>}
        </ul>
      )}
      {hasRole(user.role, ["estimator", "admin", "accounting"]) && (
        <ul>
          <li><Link href="/commissions">{user.role === "estimator" ? en.commission.navStatement : en.commission.navStatements}</Link></li>
          {canManagePayouts(user.role) && <li><Link href="/commissions/payouts">{en.commission.navPayouts}</Link></li>}
          {user.role === "admin" && <li><Link href="/settings/commission">{en.commission.navSchedule}</Link></li>}
        </ul>
      )}
      {user.role === "admin" && <p><Link href="/settings/hover">{en.hover.title}</Link></p>}
      {user.role === "admin" && <p><Link href="/settings/assemblies">{en.assemblies.title}</Link></p>}
      {hasRole(user.role, ["admin", "estimator", "production_manager", "accounting"]) && (
        <p><Link href="/jobs">{en.jobs.navLabel}</Link></p>
      )}
      <ul>
        {areas.map((a) => (
          <li key={a}>{a} <span className="muted">({en.home.comingSoon})</span></li>
        ))}
      </ul>
      <SignOutButton />
    </>
  );
}
