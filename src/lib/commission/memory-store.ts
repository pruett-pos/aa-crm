import type { Schedule } from "./periods.ts";
import type { CommissionStore, CommissionTx, Draw, EstimatorRow, LedgerEntry, NewEntry, Run } from "./types.ts";

/** In-memory store for tests. Not used by the app. */
export class MemoryCommissionStore implements CommissionStore {
  schedule: Schedule | null = null;
  estimators: EstimatorRow[] = [];
  entries: LedgerEntry[] = [];
  draws: Draw[] = [];
  runs: Run[] = [];
  applications: { runId: string; drawId: string; amountCents: number }[] = [];
  uncommissioned = 0;
  private seq = 0;

  async getSchedule() { return this.schedule; }
  async setSchedule(s: Schedule) { this.schedule = s; }
  async getEstimator(id: string) { return this.estimators.find((e) => e.id === id) ?? null; }
  async listEstimators() { return this.estimators; }
  async listEntries(estimatorId: string, limit: number) {
    return this.entries.filter((e) => e.estimatorId === estimatorId).slice(-limit).reverse();
  }
  async listDraws(estimatorId: string) { return this.draws.filter((d) => d.estimatorId === estimatorId); }
  async listRuns(estimatorId: string) { return this.runs.filter((r) => r.estimatorId === estimatorId); }
  async unpaidThrough(estimatorId: string, through: string) {
    return this.entries.filter((e) => e.estimatorId === estimatorId && !e.runId && e.entryDate <= through)
      .reduce((s, e) => s + e.amountCents, 0);
  }
  async uncommissionedPaymentCount() { return this.uncommissioned; }

  /** Test helper: add an unpaid earned entry. */
  addEarned(estimatorId: string, amountCents: number, entryDate: string, paymentId = `pay-${++this.seq}`): LedgerEntry {
    const e: LedgerEntry = {
      id: `e-${++this.seq}`, estimatorId, jobId: "job-1", jobNumber: 1, paymentId, kind: "earned", rateBps: 1000, marginBps: 4000,
      amountCents, entryDate, runId: null, paidOn: null, note: null,
    };
    this.entries.push(e);
    return e;
  }

  async transaction<T>(estimatorId: string, fn: (tx: CommissionTx) => Promise<T>): Promise<T> {
    const self = this;
    const snap = { entries: self.entries.map((e) => ({ ...e })), draws: self.draws.map((d) => ({ ...d })), runs: [...self.runs], applications: [...self.applications] };
    const tx: CommissionTx = {
      async hasRun(periodEnd) { return self.runs.some((r) => r.estimatorId === estimatorId && r.periodEnd === periodEnd); },
      async unpaidEntries(through) {
        return self.entries.filter((e) => e.estimatorId === estimatorId && !e.runId && e.entryDate <= through);
      },
      async outstandingDraws() {
        return self.draws.filter((d) => d.estimatorId === estimatorId && d.amountCents > d.appliedCents)
          .sort((a, b) => (a.paidOn < b.paidOn ? -1 : a.paidOn > b.paidOn ? 1 : 0));
      },
      async createRun(r, entryIds, apps) {
        const run: Run = { id: `run-${++self.seq}`, ...r };
        self.runs.push(run);
        for (const e of self.entries) if (entryIds.includes(e.id)) { e.runId = run.id; e.paidOn = r.paidOn; }
        for (const a of apps) {
          const d = self.draws.find((x) => x.id === a.drawId)!;
          d.appliedCents += a.amountCents;
          self.applications.push({ runId: run.id, drawId: a.drawId, amountCents: a.amountCents });
        }
        return run;
      },
      async insertDraw(d) {
        const draw: Draw = { id: `draw-${++self.seq}`, ...d, appliedCents: 0 };
        self.draws.push(draw);
        return draw;
      },
      async insertAdjustment(e: NewEntry) {
        const entry: LedgerEntry = { id: `e-${++self.seq}`, ...e, jobNumber: null, runId: null, paidOn: null };
        self.entries.push(entry);
        return entry;
      },
    };
    try {
      return await fn(tx);
    } catch (err) {
      Object.assign(self, snap);
      throw err;
    }
  }
}
