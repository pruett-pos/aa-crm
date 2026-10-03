import type { Tier } from "../scopes/types.ts";
import type { ContractStore } from "./types.ts";

export type ContractInfo = {
  selectedTier: Tier | null;
  contractCents: number | null;
  depositRequiredCents: number;
  customerName: string;
  customerEmail: string | null;
  document: { id: string; status: "draft" | "signed"; signedAt: string | null } | null;
};

/** Contract state for the scope page. Callers have already checked the user may read the job. */
export async function loadContractInfo(store: ContractStore, jobId: string): Promise<ContractInfo | null> {
  const job = await store.getContractJob(jobId);
  if (!job) return null;
  const [scope, doc] = await Promise.all([store.getSelectedScope(jobId), store.getLiveContract(jobId)]);
  return {
    selectedTier: scope?.tier ?? null,
    contractCents: job.contractCents,
    depositRequiredCents: job.depositRequiredCents,
    customerName: job.customerName,
    customerEmail: job.customerEmail,
    document: doc && doc.status !== "cancelled"
      ? { id: doc.id, status: doc.status, signedAt: doc.signedAt ? doc.signedAt.toISOString() : null }
      : null,
  };
}
