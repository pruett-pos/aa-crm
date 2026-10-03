import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { hasRole } from "@/lib/auth/roles.ts";
import { getPaymentStore } from "@/lib/payments/index.ts";
import {
  canRecordPayments, canSeeCommissionEarned, canVoidPayments, commissionEarnedSoFar, summarize,
} from "@/lib/payments/logic.ts";
import { en } from "@/i18n/en.ts";
import { PaymentsClient } from "./payments-client.tsx";

// Admin, accounting, or the job's own estimator.
export default async function PaymentsPage({ params }: { params: Promise<{ jobId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!hasRole(user.role, ["admin", "accounting", "estimator"])) redirect("/");
  const { jobId } = await params;

  const store = getPaymentStore();
  const job = await store.getPaymentJob(jobId);
  if (!job) notFound();
  if (!canRecordPayments(user, job)) redirect("/jobs");

  const payments = await store.listPayments(jobId);
  const summary = summarize(job, payments);
  const commission = canSeeCommissionEarned(user, job) ? commissionEarnedSoFar(job, summary.collectedCents) : null;

  return (
    <>
      <p><Link href="/jobs">{en.jobs.back}</Link></p>
      <h1>{en.payments.title(job.jobNumber)}</h1>
      <PaymentsClient
        jobId={job.id}
        isInsurance={job.jobType === "insurance"}
        role={user.role}
        canVoid={canVoidPayments(user.role)}
        summary={summary}
        commissionEarnedCents={commission?.earnedCents ?? null}
        payments={payments.map((p) => ({
          id: p.id, amountCents: p.amountCents, method: p.method, reference: p.reference, notes: p.notes,
          receivedAt: p.receivedAt.toISOString(), voidedAt: p.voidedAt?.toISOString() ?? null,
          voidReason: p.voidReason, hasPhoto: p.hasPhoto, isDeposit: p.isDeposit, isDepreciation: p.isDepreciation,
        }))}
      />
    </>
  );
}
