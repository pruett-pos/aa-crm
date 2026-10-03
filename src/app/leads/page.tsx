import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getLeadStore } from "@/lib/leads/index.ts";
import { canTakeLeads } from "@/lib/leads/logic.ts";
import { en } from "@/i18n/en.ts";

// CSR and admin.
export default async function LeadsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!canTakeLeads(user.role)) redirect("/");
  const leads = await getLeadStore().listLeads(100);

  return (
    <>
      <p><Link href="/">{en.home.back}</Link></p>
      <h1>{en.leads.listTitle}</h1>
      <p className="row">
        <Link className="btn-link" href="/leads/new">{en.leads.navNew}</Link>
        <Link href="/leads/review">{en.leads.navReview}</Link>
      </p>
      {leads.length === 0 ? <p className="muted">{en.leads.none}</p> : (
        <table className="lines">
          <thead>
            <tr>
              <th>{en.leads.colJob}</th><th>{en.leads.colCustomer}</th><th>{en.leads.colWhere}</th>
              <th>{en.leads.colWhat}</th><th>{en.leads.colSource}</th><th>{en.leads.colStage}</th><th>{en.leads.colAssigned}</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.jobId}>
                <td>{l.jobNumber}</td>
                <td>{l.customerName}<br /><span className="muted small-text">{l.phone ?? ""}</span></td>
                <td>{l.street}, {l.city}<br /><span className="muted small-text">{en.leads.markets[l.market]}</span></td>
                <td>{en.leads.jobTypes[l.jobType as "retail" | "insurance"] ?? l.jobType}<br />
                  <span className="muted small-text">{l.divisions.map((d) => en.leads.divisionNames[d]).join(", ")}</span></td>
                <td>{en.leads.sources[l.source]}</td>
                <td>{l.stage.replaceAll("_", " ")}</td>
                <td>
                  {l.needsReview ? <span className="badge">{en.leads.needsReview}</span>
                    : l.needsAssignment ? <span className="warn">{en.leads.needsAssignment}</span>
                    : (l.estimatorName ?? l.pmName ?? "")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
