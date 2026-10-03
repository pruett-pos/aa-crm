import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getLeadStore } from "@/lib/leads/index.ts";
import { canTakeLeads } from "@/lib/leads/logic.ts";
import { en } from "@/i18n/en.ts";
import { ReviewList } from "./review-list.tsx";

// CSR and admin. Online leads wait here until someone confirms the market.
export default async function ReviewPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!canTakeLeads(user.role)) redirect("/");
  const store = getLeadStore();
  const [leads, estimators] = await Promise.all([store.listReviewQueue(), store.listEstimators()]);

  return (
    <>
      <p><Link href="/leads">{en.leads.listTitle}</Link></p>
      <h1>{en.leads.reviewQueue}</h1>
      {leads.length === 0 ? <p className="muted">{en.leads.noneToReview}</p> : (
        <ReviewList
          estimators={estimators}
          leads={leads.map((l) => ({
            jobId: l.jobId, jobNumber: l.jobNumber, customerName: l.customerName, phone: l.phone,
            address: `${l.street}, ${l.city}`, market: l.market, jobType: l.jobType, divisions: l.divisions,
          }))}
        />
      )}
    </>
  );
}
