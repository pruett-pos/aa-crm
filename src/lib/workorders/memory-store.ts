import type { Division } from "../rules.ts";
import type {
  MaterialLine, NewLine, SourceLine, WorkOrder, WorkOrderJob, WorkOrderStatus, WorkOrderStore, WorkOrderTrade, WorkOrderTx,
} from "./types.ts";

/** In-memory store for tests. Not used by the app. */
export class MemoryWorkOrderStore implements WorkOrderStore {
  jobs: WorkOrderJob[] = [];
  trades = new Map<string, WorkOrderTrade[]>();
  pm = new Map<string, Division[]>();
  orders: (WorkOrder & { issuedBy: string | null; createdBy: string | null })[] = [];
  /** Per job and trade: the chosen package's labor lines and materials. */
  source = new Map<string, SourceLine[]>();
  materialLines = new Map<string, (MaterialLine & { itemId: string })[]>();
  estimators = new Map<string, { email: string; name: string }>();
  needing: { jobId: string; missing: number }[] = [];
  private n = 0;
  private locks = new Map<string, Promise<unknown>>();

  addJob(over: Partial<WorkOrderJob> = {}): WorkOrderJob {
    const k = this.jobs.length + 1;
    const job: WorkOrderJob = { id: `j${k}`, jobNumber: k, stage: "contract_signed", estimatorId: "est1", divisions: ["roofing"], address: "100 Example Rd, West Plains, MO 65775", contractSigned: true, ...over };
    this.jobs.push(job);
    return job;
  }
  setSource(jobId: string, division: Division, lines: SourceLine[]) { this.source.set(`${jobId}:${division}`, lines); }
  setMaterials(jobId: string, division: Division, lines: (MaterialLine & { itemId: string })[]) { this.materialLines.set(`${jobId}:${division}`, lines); }
  /** Enter a color for a material line, as the estimator would. */
  setColor(jobId: string, division: Division, itemId: string, color: string | null) {
    const l = this.materialLines.get(`${jobId}:${division}`)?.find((x) => x.itemId === itemId);
    if (l) l.color = color;
  }

  private find(jobId: string) { return this.jobs.find((j) => j.id === jobId) ?? null; }
  private mine(jobId: string) { return this.orders.filter((o) => o.jobId === jobId); }
  private strip = (o: WorkOrder & { issuedBy: string | null; createdBy: string | null }): WorkOrder => { const { issuedBy: _i, createdBy: _c, ...rest } = o; void _i; void _c; return { ...rest, lines: o.lines.map((l) => ({ ...l })) }; };

  async getJob(jobId: string) { const j = this.find(jobId); return j ? { ...j } : null; }
  async listTrades(jobId: string) { return (this.trades.get(jobId) ?? []).map((t) => ({ ...t })); }
  async pmDivisions(userId: string) { return [...(this.pm.get(userId) ?? [])]; }
  async listOrders(jobId: string) { return this.mine(jobId).map(this.strip); }
  async materials(jobId: string, division: Division) { return (this.materialLines.get(`${jobId}:${division}`) ?? []).map(({ itemId: _i, ...m }) => { void _i; return { ...m }; }); }
  async colorsMissing(jobId: string, division: Division) { return (this.materialLines.get(`${jobId}:${division}`) ?? []).filter((m) => !m.color?.trim()).length; }
  async estimatorContact(jobId: string) { const j = this.find(jobId); return j?.estimatorId ? this.estimators.get(j.estimatorId) ?? null : null; }
  async jobsNeedingColors() { return this.needing.map((x) => ({ ...x })); }

  async transaction<T>(jobId: string, fn: (tx: WorkOrderTx) => Promise<T>): Promise<T> {
    const prev = this.locks.get(jobId) ?? Promise.resolve();
    const run = prev.then(() => fn(this.tx(jobId)));
    this.locks.set(jobId, run.catch(() => undefined));
    return run;
  }

  private tx(jobId: string): WorkOrderTx {
    const self = this;
    const order = (id: string) => self.orders.find((o) => o.id === id && o.jobId === jobId);
    return {
      getJob: () => self.getJob(jobId),
      listOrders: () => self.listOrders(jobId),
      async sourceLines(division) { return (self.source.get(`${jobId}:${division}`) ?? []).map((s) => ({ ...s })); },
      colorsMissing: (division) => self.colorsMissing(jobId, division),
      async insertOrder(division, lines: NewLine[], actorId) {
        if (self.mine(jobId).some((o) => o.division === division)) throw new Error("unique violation: one work order per trade");
        self.orders.push({
          id: `wo${++self.n}`, jobId, division, status: "draft", notes: null, createdAt: new Date(Date.UTC(2026, 9, 14, 12, 0, self.n)), issuedAt: null, issuedBy: null, createdBy: actorId,
          lines: lines.map((l, i) => ({ id: `wl${++self.n}`, sortOrder: i + 1, sourceItemId: l.sourceItemId, description: l.description, quantity: l.quantity, unit: l.unit, note: l.note })),
        });
      },
      async setNotes(orderId, notes) { const o = order(orderId); if (o) o.notes = notes; },
      async addLine(orderId, line) {
        const o = order(orderId);
        if (o) o.lines.push({ id: `wl${++self.n}`, sortOrder: (o.lines.at(-1)?.sortOrder ?? 0) + 1, sourceItemId: line.sourceItemId, description: line.description, quantity: line.quantity, unit: line.unit, note: line.note });
      },
      async setLineNote(orderId, lineId, note) { const l = order(orderId)?.lines.find((x) => x.id === lineId); if (!l) return false; l.note = note; return true; },
      async removeHandLine(orderId, lineId) {
        const o = order(orderId); const i = o?.lines.findIndex((x) => x.id === lineId && x.sourceItemId === null) ?? -1;
        if (!o || i < 0) return false;
        o.lines.splice(i, 1);
        return true;
      },
      async setStatus(orderId, status: WorkOrderStatus, actorId, at) {
        const o = order(orderId);
        if (!o) return;
        o.status = status;
        o.issuedAt = status === "issued" ? at : null;
        o.issuedBy = status === "issued" ? actorId : null;
      },
    };
  }
}
