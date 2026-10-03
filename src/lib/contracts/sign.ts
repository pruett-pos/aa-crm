import { createHash } from "node:crypto";
import { STAGES, type Stage } from "../rules.ts";
import { selectScope } from "./select.ts";
import { renderContractPdf, renderSignedContractPdf, type ContractData } from "./pdf.ts";
import type { ContractStore, DocumentRecord, JobStageOrClosed } from "./types.ts";
import type { Tier } from "../scopes/types.ts";

export type ContractErrorCode =
  | "not_found" | "no_selection" | "missing_customer" | "job_closed" | "already_signed" | "not_draft"
  | "consent_required" | "name_required" | "email_invalid" | "signature_invalid" | "tampered";

export class ContractError extends Error {
  code: ContractErrorCode;
  constructor(code: ContractErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const CONTRACT_SIGNED_INDEX = STAGES.indexOf("contract_signed");
/** Signing moves a job up to contract_signed and never backward. */
export function stageAfterSigning(current: JobStageOrClosed): Stage | null {
  if (current === "lost" || current === "cancelled_after_approval") return null;
  return STAGES.indexOf(current) < CONTRACT_SIGNED_INDEX ? "contract_signed" : current;
}

// ---------- Selecting a package ----------
export async function selectPackage(store: ContractStore, jobId: string, tier: Tier, userId: string, scope: Parameters<typeof selectScope>[0]) {
  const job = await store.getContractJob(jobId);
  if (!job) throw new ContractError("not_found");
  if (await store.hasSignedContract(jobId)) throw new ContractError("already_signed", "A contract is already signed for this job");
  const selection = selectScope(scope, await store.specialOrderProductIds(), job.stage);
  await store.applySelection(jobId, tier, selection, userId);
  return selection;
}

// ---------- Preparing the contract ----------
export async function prepareContract(
  store: ContractStore, jobId: string, now: () => Date = () => new Date(),
): Promise<DocumentRecord> {
  const job = await store.getContractJob(jobId);
  if (!job) throw new ContractError("not_found");
  if (job.stage === "lost" || job.stage === "cancelled_after_approval") throw new ContractError("job_closed");
  if (await store.hasSignedContract(jobId)) throw new ContractError("already_signed");
  const scope = await store.getSelectedScope(jobId);
  if (!scope || !job.contractCents) throw new ContractError("no_selection", "Select a package first");
  if (!job.customerName.trim()) throw new ContractError("missing_customer");

  const data: ContractData = {
    jobNumber: job.jobNumber, customerName: job.customerName, propertyAddress: job.propertyAddress,
    packageTitle: scope.title,
    items: scope.items.map((i) => ({
      description: i.description, quantity: i.quantity, unitPriceCents: i.unitPriceCents, color: i.color,
    })),
    totalCents: scope.saleCents, depositCents: job.depositRequiredCents, issuedOn: now(),
  };
  const bytes = await renderContractPdf(data);
  return store.createContractDocument(jobId, { bytes, sha256: sha256Hex(bytes), signerEmail: job.customerEmail });
}

// ---------- Signing ----------
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_MIN_BYTES = 1200;      // a blank canvas compresses to a few hundred bytes
const PNG_MAX_BYTES = 400_000;
const PNG_MAX_DIM = 4000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Decode and sanity-check a signature drawn on a canvas. Throws ContractError("signature_invalid"). */
export function decodeSignaturePng(dataUrl: string): Uint8Array {
  const prefix = "data:image/png;base64,";
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix) || dataUrl.length > PNG_MAX_BYTES * 2) {
    throw new ContractError("signature_invalid");
  }
  const bytes = new Uint8Array(Buffer.from(dataUrl.slice(prefix.length), "base64"));
  if (bytes.length < PNG_MIN_BYTES || bytes.length > PNG_MAX_BYTES) throw new ContractError("signature_invalid");
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) throw new ContractError("signature_invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (width < 20 || height < 10 || width > PNG_MAX_DIM || height > PNG_MAX_DIM) throw new ContractError("signature_invalid");
  return bytes;
}

export type SignInput = {
  documentId: string;
  userId: string;                  // the estimator running the session
  consent: boolean;
  signerName: string;
  signerEmail: string;
  signaturePngDataUrl: string;
  ip: string | null;
  userAgent: string | null;
};

export type SignResult = { signedData: Uint8Array; signedSha256: string; signerEmail: string; jobNumber: number; signerName: string };

export async function finalizeSignature(
  store: ContractStore, input: SignInput, now: () => Date = () => new Date(),
): Promise<SignResult> {
  const doc = await store.getDocument(input.documentId);
  if (!doc) throw new ContractError("not_found");
  if (doc.status === "signed") throw new ContractError("already_signed");
  if (doc.status !== "draft" || !doc.unsignedData || !doc.unsignedSha256) throw new ContractError("not_draft");

  const job = await store.getContractJob(doc.jobId);
  if (!job) throw new ContractError("not_found");
  if (job.stage === "lost" || job.stage === "cancelled_after_approval") throw new ContractError("job_closed");

  if (input.consent !== true) throw new ContractError("consent_required");
  const signerName = input.signerName.trim();
  if (signerName.length < 2 || signerName.length > 120) throw new ContractError("name_required");
  const signerEmail = input.signerEmail.trim();
  if (!EMAIL.test(signerEmail) || signerEmail.length > 254) throw new ContractError("email_invalid");
  const png = decodeSignaturePng(input.signaturePngDataUrl);

  // The file we are about to sign must be byte-for-byte what was stored when it was prepared.
  if (sha256Hex(doc.unsignedData) !== doc.unsignedSha256) throw new ContractError("tampered");

  const signedAt = now();
  const signedData = await renderSignedContractPdf(doc.unsignedData, {
    signerName, signerEmail, signaturePng: png, signedAt, consentAt: signedAt,
    ip: input.ip, userAgent: input.userAgent, unsignedSha256: doc.unsignedSha256,
    jobNumber: job.jobNumber, estimatorName: job.estimatorName ?? "an estimator",
  });
  const signedSha256 = sha256Hex(signedData);

  const ok = await store.completeSignature({
    documentId: doc.id, jobId: doc.jobId, signedData, signedSha256,
    signature: {
      documentId: doc.id, signerName, signerEmail, consentAt: signedAt, signedAt,
      ip: input.ip, userAgent: input.userAgent, signaturePng: png, signatureSha256: sha256Hex(png),
      signedByUserId: input.userId,
    },
    newStage: stageAfterSigning(job.stage), previousStage: job.stage,
  });
  if (!ok) throw new ContractError("already_signed");
  return { signedData, signedSha256, signerEmail, jobNumber: job.jobNumber, signerName };
}
