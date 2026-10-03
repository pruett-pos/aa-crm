import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { canWriteScopes } from "@/lib/scopes/service.ts";
import { getContractStore } from "@/lib/contracts/index.ts";
import { en } from "@/i18n/en.ts";
import { SigningForm } from "./signing-form.tsx";

// Admin or the job's own estimator only: the estimator runs the signing session on their device.
export default async function SignPage({ params }: { params: Promise<{ jobId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { jobId } = await params;

  const job = await getScopeStore().getJob(jobId);
  if (!job) notFound();
  if (!canWriteScopes(user, job)) redirect(`/jobs`);

  const contracts = getContractStore();
  const [info, doc] = await Promise.all([contracts.getContractJob(jobId), contracts.getLiveContract(jobId)]);
  if (!info || !doc || doc.status !== "draft") redirect(`/jobs/${jobId}/scope`);

  return (
    <>
      <p><Link href={`/jobs/${jobId}/scope`}>{en.contract.backToScope}</Link></p>
      <h1>{en.contract.signingTitle(info.jobNumber)}</h1>
      <SigningForm
        jobId={jobId} documentId={doc.id}
        customerName={info.customerName} customerEmail={info.customerEmail ?? ""}
      />
    </>
  );
}
