import type { Division, Stage } from "../rules.ts";
import type { JobStageOrClosed } from "../production/types.ts";
import type {
  CloseoutJob, CloseoutStore, CloseoutTrade, CloseoutTx, InvoiceRow, InvoiceSection, NewInvoice, NewPunchItem, PunchItem,
} from "./types.ts";

/** In-memory store for tests. Not used by the app. */
export class MemoryCloseoutStore implements CloseoutStore {
  jobs: CloseoutJob[] = [];
  trades = new Map<string, CloseoutTrade[]>();
  pm = new Map<string, Division[]>();
  items: (PunchItem & { jobId: string })[] = [];
  payments: { jobId: string; amountCents: number; voided: boolean }[] = [];
  sections = new Map<string, InvoiceSection[]>();
  invoices: (InvoiceRow & { pdf: Uint8Array })[] = [];
  stageHistory: { jobId: string; from: string; to: string; by: string }[] = [];
  private nextNumber = 1001;
  private nextItem = 1;
  private locks = new Map<string, Promise<unknown>>();

  addJob(over: Partial<CloseoutJob> = {}): CloseoutJob {
    const n = this.jobs.length + 1;
    const job: CloseoutJob = {
      id: `j${n}`, jobNumber: n, jobType: "retail", stage: "closeout_punchlist", estimatorId: "est1", divisions: ["roofing"],
      customerName: "Dana Miller", customerEmail: "dana@example.com", propertyAddress: "100 Example Rd, West Plains, MO 65775",
      contractCents: 1_000_000, contractSigned: true, ...over,
    };
    this.jobs.push(job);
    if (!this.trades.has(job.id)) this.trades.set(job.id, job.divisions.map((d) => ({ division: d, status: "complete", crewLeaderId: null })));
    if (!this.sections.has(job.id)) this.sections.set(job.id, job.divisions.map((d) => ({ division: d, packageTitle: "Better", subtotalCents: Math.round((job.contractCents ?? 0) / job.divisions.length) })));
    return job;
  }
  pay(jobId: string, amountCents: number, voided = false) { this.payments.push({ jobId, amountCents, voided }); }
  itemsOf(jobId: string) { return this.items.filter((i) => i.jobId === jobId); }

  private job(id: string) { return this.jobs.find((j) => j.id === id) ?? null; }
  private row = (i: InvoiceRow & { pdf: Uint8Array }): InvoiceRow => { const { pdf: _pdf, ...rest } = i; void _pdf; return { ...rest }; };

  async getJob(jobId: string) { const j = this.job(jobId); return j ? { ...j } : null; }
  async listTrades(jobId: string) { return (this.trades.get(jobId) ?? []).map((t) => ({ ...t })); }
  async pmDivisions(userId: string) { return [...(this.pm.get(userId) ?? [])]; }
  async listItems(jobId: string) { return this.itemsOf(jobId).map(({ jobId: _j, ...i }) => { void _j; return { ...i }; }).sort((a, b) => a.sortOrder - b.sortOrder); }
  async listInvoices(jobId: string) { return this.invoices.filter((i) => i.jobId === jobId).map(this.row); }
  async collectedCents(jobId: string) { return this.payments.filter((p) => p.jobId === jobId && !p.voided).reduce((s, p) => s + p.amountCents, 0); }
  async getInvoice(id: string) { const i = this.invoices.find((x) => x.id === id); return i ? this.row(i) : null; }
  async getInvoicePdf(id: string) { return this.invoices.find((x) => x.id === id)?.pdf ?? null; }
  async recordEmail(id: string, e: { to: string; status: "sent" | "failed"; error: string | null; at: Date }) {
    const i = this.invoices.find((x) => x.id === id);
    if (i) Object.assign(i, { emailedTo: e.to, emailStatus: e.status, emailError: e.error, emailedAt: e.status === "sent" ? e.at : i.emailedAt });
  }

  /** Runs one job's work at a time, like the row lock in the database. */
  async transaction<T>(jobId: string, fn: (tx: CloseoutTx) => Promise<T>): Promise<T> {
    const prev = this.locks.get(jobId) ?? Promise.resolve();
    const run = prev.then(() => fn(this.tx(jobId)));
    this.locks.set(jobId, run.catch(() => undefined));
    return run;
  }

  private tx(jobId: string): CloseoutTx {
    const self = this;
    return {
      getJob: () => self.getJob(jobId),
      listTrades: () => self.listTrades(jobId),
      listItems: () => self.listItems(jobId),
      async insertItems(items: NewPunchItem[], actorId: string) {
        void actorId;
        const base = self.itemsOf(jobId).reduce((m, i) => Math.max(m, i.sortOrder), 0);
        items.forEach((it, k) => self.items.push({
          id: `i${self.nextItem++}`, jobId, division: it.division, labelEn: it.labelEn, labelRu: it.labelRu, sortOrder: base + k + 1,
          done: false, doneBy: null, doneAt: null,
        }));
      },
      async updateItem(id, patch, actorId, at) {
        const i = self.items.find((x) => x.id === id && x.jobId === jobId);
        if (!i) return false;
        if (patch.labelEn !== undefined) i.labelEn = patch.labelEn;
        if (patch.labelRu !== undefined) i.labelRu = patch.labelRu;
        if (patch.done !== undefined) Object.assign(i, patch.done ? { done: true, doneBy: actorId, doneAt: at } : { done: false, doneBy: null, doneAt: null });
        return true;
      },
      async deleteItem(id) {
        const k = self.items.findIndex((x) => x.id === id && x.jobId === jobId);
        if (k < 0) return false;
        self.items.splice(k, 1);
        return true;
      },
      collectedCents: () => self.collectedCents(jobId),
      async chosenSections() { return [...(self.sections.get(jobId) ?? [])]; },
      async liveInvoice() { const i = self.invoices.find((x) => x.jobId === jobId && x.status === "issued"); return i ? self.row(i) : null; },
      async nextInvoiceNumber() { return self.nextNumber++; },
      async insertInvoice(i: NewInvoice) {
        if (self.invoices.some((x) => x.jobId === jobId && x.status === "issued")) throw new Error("unique violation: one live invoice per job");
        const row: InvoiceRow & { pdf: Uint8Array } = {
          id: `inv${i.invoiceNumber}`, jobId, invoiceNumber: i.invoiceNumber, issuedAt: i.issuedAt, dueOn: i.dueOn, contractCents: i.contractCents,
          paidCents: i.paidCents, balanceCents: i.balanceCents, status: "issued", issuedBy: i.issuedBy, emailedTo: null, emailedAt: null,
          emailStatus: null, emailError: null, voidedAt: null, voidReason: null, pdf: i.pdf,
        };
        self.invoices.push(row);
        return self.row(row);
      },
      async voidInvoice(id, _by, reason, at) {
        const i = self.invoices.find((x) => x.id === id && x.status === "issued");
        if (!i) return false;
        Object.assign(i, { status: "void", voidedAt: at, voidReason: reason });
        return true;
      },
      async setStage(from: JobStageOrClosed, to: Stage, actorId: string) {
        const j = self.job(jobId)!;
        j.stage = to;
        self.stageHistory.push({ jobId, from, to, by: actorId });
      },
    };
  }
}
