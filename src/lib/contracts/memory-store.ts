import { STAGES, type Division, type Stage } from "../rules.ts";
import type { StoredScope, Tier } from "../scopes/types.ts";
import { combineSelections, stageAfterSelection, type Combined } from "./select.ts";
import type { ContractJob, ContractStore, DocumentRecord, JobStageOrClosed, SignatureRecord } from "./types.ts";

/** In-memory store for tests. Not used by the app. */
export class MemoryContractStore implements ContractStore {
  jobs: ContractJob[] = [];
  scopes: (StoredScope & { jobId: string })[] = [];
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
  async getSelectedScopes(jobId: string) {
    return this.scopes.filter((s) => s.jobId === jobId && s.selected);
  }
  async specialOrderProductIds() {
    return this.specialOrder;
  }
  /** Recompute the job's contract figures from every trade's chosen package. */
  private recompute(jobId: string): Combined | null {
    const j = this.job(jobId);
    const chosen = this.scopes.filter((s) => s.jobId === jobId && s.selected);
    if (chosen.length === 0) {
      j.contractCents = null;
      j.depositRequiredCents = 0;
      return null;
    }
    const c = combineSelections(chosen, this.specialOrder);
    j.contractCents = c.contractCents;
    j.depositRequiredCents = c.depositRequiredCents;
    return c;
  }
  private cancelDrafts(jobId: string) {
    this.docs.filter((d) => d.jobId === jobId && d.status === "draft").forEach((d) => { d.status = "cancelled"; });
  }
  async applySelection(jobId: string, division: Division, tier: Tier, userId: string) {
    const j = this.job(jobId);
    const target = this.scopes.find((s) => s.jobId === jobId && s.division === division && s.tier === tier);
    if (!target) throw new Error("Package has not been saved yet");
    for (const s of this.scopes.filter((x) => x.jobId === jobId && x.division === division)) s.selected = s.tier === tier;
    const combined = this.recompute(jobId)!;
    this.cancelDrafts(jobId);
    const next = stageAfterSelection(j.stage);
    if (next !== j.stage && next !== "lost" && next !== "cancelled_after_approval") {
      this.history.push({ jobId, from: j.stage, to: next, by: userId });
      j.stage = next;
    }
    return combined;
  }
  async clearSelectionIfSelected(jobId: string, division: Division, tier: Tier) {
    const s = this.scopes.find((x) => x.jobId === jobId && x.division === division && x.tier === tier && x.selected);
    if (!s) return;
    s.selected = false;
    this.recompute(jobId);
    this.cancelDrafts(jobId);
  }
  async addDivision(jobId: string, division: Division) {
    const j = this.job(jobId);
    if (!j.divisions.includes(division)) j.divisions = [...j.divisions, division];
  }
  async removeDivision(jobId: string, division: Division) {
    const j = this.job(jobId);
    j.divisions = j.divisions.filter((d) => d !== division);
    this.scopes = this.scopes.filter((s) => !(s.jobId === jobId && s.division === division));
    this.recompute(jobId);
    this.cancelDrafts(jobId);
  }  async hasSignedContract(jobId: string) {
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
