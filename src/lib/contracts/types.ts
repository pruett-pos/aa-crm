import type { Stage } from "../rules.ts";
import type { StoredScope, Tier } from "../scopes/types.ts";
import type { Selection } from "./select.ts";

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
  getSelectedScope(jobId: string): Promise<StoredScope | null>;
  specialOrderProductIds(): Promise<Set<string>>;
  /** Mark this tier selected (and others not), copy price/deposit to the job, cancel draft contracts, log stage change. */
  applySelection(jobId: string, tier: Tier, selection: Selection, userId: string): Promise<void>;
  /** If the tier is the selected one: unselect it, clear the job's contract figures and cancel draft contracts. */
  clearSelectionIfSelected(jobId: string, tier: Tier): Promise<void>;
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
