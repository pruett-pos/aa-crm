import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { loadScopeData } from "@/lib/scopes/load.ts";
import { getContractStore } from "@/lib/contracts/index.ts";
import { loadContractInfo } from "@/lib/contracts/load.ts";
import { hasRole } from "@/lib/auth/roles.ts";
import { en } from "@/i18n/en.ts";
import { ScopeBuilder } from "./scope-builder.tsx";
import { ContractPanel } from "./contract-panel.tsx";
import { MeasurementsPanel } from "./measurements-panel.tsx";

export default async function ScopePage({ params }: { params: Promise<{ jobId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!hasRole(user.role, ["admin", "estimator", "production_manager"])) redirect("/");

  const { jobId } = await params;
  const data = await loadScopeData(getScopeStore(), user, jobId);
  if (data.status === "not_found") notFound();
  if (data.status === "forbidden") redirect("/jobs");
  const contract = await loadContractInfo(getContractStore(), jobId);

  return (
    <>
      <p><Link href="/jobs">{en.jobs.back}</Link></p>
      <h1>{en.scope.title(data.job.jobNumber)}</h1>
      <MeasurementsPanel jobId={data.job.id} />
      <ScopeBuilder
        jobId={data.job.id}
        canEdit={data.canEdit}
        role={data.viewerRole}
        commissionOwnTruck={data.commissionOwnTruck}
        products={data.products}
        initial={data.scopes}
        divisions={data.divisions}
        chosen={Object.fromEntries((contract?.trades ?? []).map((t) => [t.division, t.selectedTier]))}
        locked={contract?.document?.status === "signed"}
      />
      {contract && <ContractPanel jobId={data.job.id} canEdit={data.canEdit} info={contract} />}
    </>
  );
}
