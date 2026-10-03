import type { Division } from "../rules.ts";
import type { Tier } from "../scopes/types.ts";
import type { ContractStore } from "./types.ts";

export type ContractInfo = {
  /** Every trade on the job, in order, with the package chosen for it (if any). */
  trades: { division: Division; selectedTier: Tier | null; packageTitle: string | null; subtotalCents: number | null }[];
  /** True when every trade has a chosen package, so the contract can be prepared. */
  allTradesChosen: boolean;
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
  const [chosen, doc] = await Promise.all([store.getSelectedScopes(jobId), store.getLiveContract(jobId)]);
  const trades = (job.divisions as Division[]).map((division) => {
    const s = chosen.find((x) => x.division === division);
    return { division, selectedTier: s?.tier ?? null, packageTitle: s?.title ?? null, subtotalCents: s ? s.saleCents : null };
  });
  return {
    trades,
    allTradesChosen: trades.length > 0 && trades.every((t) => t.selectedTier !== null),
    contractCents: job.contractCents,
    depositRequiredCents: job.depositRequiredCents,
    customerName: job.customerName,
    customerEmail: job.customerEmail,
    document: doc && doc.status !== "cancelled"
      ? { id: doc.id, status: doc.status, signedAt: doc.signedAt ? doc.signedAt.toISOString() : null }
      : null,
  };
}