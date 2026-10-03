import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getLeadStore } from "@/lib/leads/index.ts";
import { canTakeLeads } from "@/lib/leads/logic.ts";
import { en } from "@/i18n/en.ts";
import { IntakeForm } from "./intake-form.tsx";

// CSR and admin.
export default async function NewLeadPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!canTakeLeads(user.role)) redirect("/");
  const estimators = await getLeadStore().listEstimators();

  return (
    <>
      <p><Link href="/leads">{en.leads.listTitle}</Link></p>
      <h1>{en.leads.newLead}</h1>
      <IntakeForm estimators={estimators} />
    </>
  );
}
