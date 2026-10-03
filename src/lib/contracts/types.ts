import type { Division, Stage } from "../rules.ts";
import type { StoredScope, Tier } from "../scopes/types.ts";
import type { Combined } from "./select.ts";

export type JobStageOrClosed = Stage | "lost" | "cancelled_after_approval";

export type ContractJob = {
  id: string;
  jobNumber: number;
  stage: JobStageOrClosed;
  estimatorId: string | null;
  estimatorName: string | null;
  divisions: string[];
  productionManagerId: string | null;
  contractCents: number | null;
  depositRequiredCents: number;
  customerName: string;
  customerEmail: string | null;
  propertyAddress: string;
};

export type DocumentRecord = {
  id: string;
  jobId: string;
  status: "draft" | "signed" | "cancelled";
  signerEmail: string | null;
  unsignedData: Uint8Array | null;
  unsignedSha256: string | null;
  signedData: Uint8Array | null;
  signedSha256: string | null;
  signedAt: Date | null;
};

export type SignatureRecord = {
  documentId: string;
  signerName: string;
  signerEmail: string;
  consentAt: Date;
  signedAt: Date;
  ip: string | null;
  userAgent: string | null;
  signaturePng: Uint8Array;
  signatureSha256: string;
  signedByUserId: string;
};

export interface ContractStore {
  getContractJob(jobId: string): Promise<ContractJob | null>;
  /** The chosen package of each trade on the job. */
  getSelectedScopes(jobId: string): Promise<StoredScope[]>;
  specialOrderProductIds(): Promise<Set<string>>;
  /**
   * Choose this tier for one trade (unchoosing that trade's other tiers), recompute the job's contract, cost, special-order
   * flag and deposit from every trade's chosen package, move the stage up, log it, and cancel any draft contract.
   */
  applySelection(jobId: string, division: Division, tier: Tier, userId: string): Promise<Combined>;
  /** If this package is the chosen one for its trade: unchoose it, recompute the job's figures from what remains chosen, cancel draft contracts. */
  clearSelectionIfSelected(jobId: string, division: Division, tier: Tier): Promise<void>;
  /** Add a trade to the job. */
  addDivision(jobId: string, division: Division): Promise<void>;
  /** Remove a trade: deletes its unsigned estimates, recomputes the job's figures, cancels draft contracts. */
  removeDivision(jobId: string, division: Division): Promise<void>;
  hasSignedContract(jobId: string): Promise<boolean>;
  getLiveContract(jobId: string): Promise<DocumentRecord | null>;
  getDocument(id: string): Promise<DocumentRecord | null>;
  /** Replaces any draft contract; refuses when a contract is already signed. */
  createContractDocument(jobId: string, d: { bytes: Uint8Array; sha256: string; signerEmail: string | null }): Promise<DocumentRecord>;
  /**
   * Atomic: succeeds only if the document is still a draft. Sets it signed with the signed PDF,
   * stores the signature record, and advances the job stage with history. Returns false if it was no longer a draft.
   */
  completeSignature(a: {
    documentId: string; jobId: string; signedData: Uint8Array; signedSha256: string;
    signature: SignatureRecord; newStage: Stage | null; previousStage: JobStageOrClosed;
  }): Promise<boolean>;
}
