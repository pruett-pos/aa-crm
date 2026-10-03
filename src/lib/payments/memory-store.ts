import type { Stage } from "../rules.ts";
import type { NewEntry } from "../commission/types.ts";
import type {
  JobStageOrClosed, NewPayment, PaymentJob, PaymentRecord, PaymentStore, PaymentTx,
} from "./types.ts";

/** In-memory store for tests. Not used by the app. */
export class MemoryPaymentStore implements PaymentStore {
  jobs: PaymentJob[] = [];
  rows: (PaymentRecord & { photo: { data: Uint8Array; mime: string } | null; voidedBy: string | null })[] = [];
  history: { jobId: string; from: JobStageOrClosed; to: Stage; by: string }[] = [];
  commission: NewEntry[] = [];
  private seq = 0;

  async getPaymentJob(jobId: string) {
    return this.jobs.find((j) => j.id === jobId) ?? null;
  }
  async listPayments(jobId: string) {
    return this.rows.filter((r) => r.jobId === jobId).map(({ photo: _p, voidedBy: _v, ...rec }) => rec);
  }
  async getPayment(id: string) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return null;
    const { photo: _p, voidedBy: _v, ...rec } = r;
    return rec;
  }
  async getPhoto(id: string) {
    return this.rows.find((x) => x.id === id)?.photo ?? null;
  }
  async transaction<T>(jobId: string, fn: (tx: PaymentTx) => Promise<T>): Promise<T> {
    const self = this;
    const tx: PaymentTx = {
      getJob: () => self.getPaymentJob(jobId),
      list: () => self.listPayments(jobId),
      async insert(p: NewPayment) {
        const row = {
          id: `pay-${++self.seq}`, jobId, amountCents: p.amountCents, method: p.method,
          isDeposit: p.isDeposit, isDepreciation: p.isDepreciation, reference: p.reference, notes: p.notes,
          collectedBy: p.collectedBy, receivedAt: p.receivedAt, voidedAt: null, voidReason: null,
          hasPhoto: p.photo !== null, photo: p.photo, voidedBy: null,
        };
        self.rows.push(row);
        const { photo: _p, voidedBy: _v, ...rec } = row;
        return rec;
      },
      async setStage(from, to, userId) {
        const j = self.jobs.find((x) => x.id === jobId)!;
        j.stage = to;
        self.history.push({ jobId, from, to, by: userId });
      },
      async void(paymentId, userId, reason, at) {
        const r = self.rows.find((x) => x.id === paymentId);
        if (!r || r.voidedAt) return false;
        r.voidedAt = at; r.voidReason = reason; r.voidedBy = userId;
        return true;
      },
      async insertCommission(e) { self.commission.push(e); },
      async reverseCommission(paymentId, entryDate) {
        const earned = self.commission.find((c) => c.paymentId === paymentId && c.kind === "earned");
        if (!earned || self.commission.some((c) => c.paymentId === paymentId && c.kind === "reversal")) return;
        self.commission.push({ ...earned, kind: "reversal", amountCents: -earned.amountCents, entryDate, note: null });
      },
    };
    return fn(tx);
  }
}
