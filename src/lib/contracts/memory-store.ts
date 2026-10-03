import { STAGES, type Stage } from "../rules.ts";
import type { StoredScope, Tier } from "../scopes/types.ts";
import type { Selection } from "./select.ts";
import type { ContractJob, ContractStore, DocumentRecord, JobStageOrClosed, SignatureRecord } from "./types.ts";

/** In-memory store for tests. Not used by the app. */
export class MemoryContractStore implements ContractStore {
  jobs: ContractJob[] = [];
  scopes: (StoredScope & { jobId: string; selected: boolean })[] = [];
  specialOrder = new Set<string>();
  docs: DocumentRecord[] = [];
  signatures: SignatureRecord[] = [];
  history: { jobId: string; from: JobStageOrClosed | null; to: Stage; by: string | null }[] = [];
  private seq = 0;

  private job(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new Error("no such job");
    return j;
  }

  async getContractJob(jobId: string) {
    return this.jobs.find((j) => j.id === jobId) ?? null;
  }
  async getSelectedScope(jobId: string) {
    return this.scopes.find((s) => s.jobId === jobId && s.selected) ?? null;
  }
  async specialOrderProductIds() {
    return this.specialOrder;
  }
  async applySelection(jobId: string, tier: Tier, sel: Selection, userId: string) {
    const j = this.job(jobId);
    for (const s of this.scopes.filter((x) => x.jobId === jobId)) s.selected = s.tier === tier;
    j.contractCents = sel.contractCents;
    j.depositRequiredCents = sel.depositRequiredCents;
    this.docs.filter((d) => d.jobId === jobId && d.status === "draft").forEach((d) => { d.status = "cancelled"; });
    if (j.stage !== sel.stage) {
      this.history.push({ jobId, from: j.stage, to: sel.stage, by: userId });
      j.stage = sel.stage;
    }
  }
  async clearSelectionIfSelected(jobId: string, tier: Tier) {
    const s = this.scopes.find((x) => x.jobId === jobId && x.tier === tier && x.selected);
    if (!s) return;
    s.selected = false;
    const j = this.job(jobId);
    j.contractCents = null;
    j.depositRequiredCents = 0;
    this.docs.filter((d) => d.jobId === jobId && d.status === "draft").forEach((d) => { d.status = "cancelled"; });
  }
  async hasSignedContract(jobId: string) {
    return this.docs.some((d) => d.jobId === jobId && d.status === "signed");
  }
  async getLiveContract(jobId: string) {
    return this.docs.find((d) => d.jobId === jobId && d.status !== "cancelled") ?? null;
  }
  async getDocument(id: string) {
    return this.docs.find((d) => d.id === id) ?? null;
  }
  async createContractDocument(jobId: string, d: { bytes: Uint8Array; sha256: string; signerEmail: string | null }) {
    if (await this.hasSignedContract(jobId)) throw new Error("already signed");
    this.docs.filter((x) => x.jobId === jobId && x.status === "draft").forEach((x) => { x.status = "cancelled"; });
    const rec: DocumentRecord = {
      id: `doc-${++this.seq}`, jobId, status: "draft", signerEmail: d.signerEmail,
      unsignedData: d.bytes, unsignedSha256: d.sha256, signedData: null, signedSha256: null, signedAt: null,
    };
    this.docs.push(rec);
    return rec;
  }
  async completeSignature(a: Parameters<ContractStore["completeSignature"]>[0]) {
    const doc = this.docs.find((d) => d.id === a.documentId);
    if (!doc || doc.status !== "draft") return false;
    doc.status = "signed";
    doc.signedData = a.signedData;
    doc.signedSha256 = a.signedSha256;
    doc.signedAt = a.signature.signedAt;
    this.signatures.push(a.signature);
    if (a.newStage && a.newStage !== a.previousStage) {
      this.history.push({ jobId: a.jobId, from: a.previousStage, to: a.newStage, by: a.signature.signedByUserId });
      this.job(a.jobId).stage = a.newStage;
    }
    return true;
  }
}

export { STAGES };
