import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { can } from "@/lib/auth/roles.ts";
import { en } from "@/i18n/en.ts";
import { SignOutButton } from "./sign-out-button.tsx";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Placeholder links by capability; real pages arrive in later slices.
  const areas = [
    can(user.role, "createLeads") && "Leads",
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
      <ul>
        {areas.map((a) => (
          <li key={a}>{a} <span className="muted">({en.home.comingSoon})</span></li>
        ))}
      </ul>
      <SignOutButton />
    </>
  );
}
