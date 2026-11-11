import type {
  DuplicateFlag, CrmInvoice, CrmPayment, InvoicePayload, Link, LinkType, NewSyncJob, QboSettings, QboStore, SyncJob, SyncKind, SyncPatch, SyncStatus,
} from "./types.ts";

/** In-memory store for tests: the queue plus fixture CRM records. Not used by the app. */
export class MemoryQboStore implements QboStore {
  jobs: SyncJob[] = [];
  links = new Map<string, Link>();
  refs = new Map<string, string>();
  classMap: Record<string, string> = {};
  itemMap: Record<string, string> = {};
  settings: QboSettings = { realmId: null, companyName: null, environment: null, connectedAt: null, syncFrom: null };
  // fixtures
  invoices: CrmInvoice[] = [];
  invoiceLineRows = new Map<string, InvoicePayload["lines"]>();
  payments: CrmPayment[] = [];
  flags: DuplicateFlag[] = [];
  private seq = 0;

  async enqueue(j: NewSyncJob, now: Date): Promise<SyncJob> {
    const found = this.jobs.find((x) => x.kind === j.kind && x.entityId === j.entityId);
    if (found) return { ...found };
    const job: SyncJob = {
      id: `job-${++this.seq}`, kind: j.kind, entityId: j.entityId, status: "pending", attempts: 0, nextAttemptAt: now, lockedAt: null, lastError: null,
      qboId: null, requestId: crypto.randomUUID(), payload: j.payload ?? null, crmTotalCents: j.crmTotalCents ?? null, qboTotalCents: null,
      mismatch: false, createdAt: now, updatedAt: now,
    };
    this.jobs.push(job);
    return { ...job };
  }
  async getJob(id: string) { const j = this.jobs.find((x) => x.id === id); return j ? { ...j } : null; }
  async findJob(kind: SyncKind, entityId: string) { const j = this.jobs.find((x) => x.kind === kind && x.entityId === entityId); return j ? { ...j } : null; }
  async claimDue(now: Date, limit: number, staleMs: number) {
    const due = this.jobs
      .filter((j) => ((j.status === "pending" || j.status === "waiting") && j.nextAttemptAt <= now) || (j.status === "running" && j.lockedAt && now.getTime() - j.lockedAt.getTime() > staleMs))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || Number(a.id.slice(4)) - Number(b.id.slice(4)))
      .slice(0, limit);
    for (const j of due) { j.status = "running"; j.lockedAt = now; }
    return due.map((j) => ({ ...j }));
  }
  async updateJob(id: string, patch: SyncPatch, now: Date) {
    const j = this.jobs.find((x) => x.id === id);
    if (j) Object.assign(j, patch, { updatedAt: now });
  }
  async listJobs(f: { statuses?: SyncStatus[]; mismatchOnly?: boolean; limit: number }) {
    return this.jobs.filter((j) => (!f.statuses || f.statuses.includes(j.status)) && (!f.mismatchOnly || j.mismatch)).slice(0, f.limit).map((j) => ({ ...j }));
  }
  async counts() {
    const c = { pending: 0, waiting: 0, running: 0, done: 0, failed: 0, cancelled: 0, mismatch: 0 };
    for (const j of this.jobs) { c[j.status]++; if (j.mismatch) c.mismatch++; }
    return c;
  }

  private k = (t: LinkType, id: string) => `${t}:${id}`;
  async getLink(t: LinkType, id: string) { return this.links.get(this.k(t, id)) ?? null; }
  async setLink(t: LinkType, id: string, qboId: string, parent: string | null = null) { this.links.set(this.k(t, id), { qboId, parentQboId: parent }); }
  async deleteLink(t: LinkType, id: string) { this.links.delete(this.k(t, id)); }
  async paymentIdsLinkedToInvoice(invoiceQboId: string) {
    return [...this.links].filter(([k, l]) => k.startsWith("payment:") && l.parentQboId === invoiceQboId).map(([k]) => k.slice("payment:".length));
  }
  async addDuplicateFlag(f: Omit<DuplicateFlag, "status" | "createdAt">, now: Date) {
    if (!this.flags.some((x) => x.customerId === f.customerId)) this.flags.push({ ...f, status: "open", createdAt: now });
  }
  async listDuplicateFlags(status: DuplicateFlag["status"]) { return this.flags.filter((f) => f.status === status).map((f) => ({ ...f })); }
  async getDuplicateFlag(id: string) { const f = this.flags.find((x) => x.customerId === id); return f ? { ...f } : null; }
  async resolveDuplicateFlag(id: string, status: "linked" | "dismissed") { const f = this.flags.find((x) => x.customerId === id); if (f) f.status = status; }
  async getRef(kind: string, key: string) { return this.refs.get(`${kind}:${key}`) ?? null; }
  async setRef(kind: string, key: string, id: string) { this.refs.set(`${kind}:${key}`, id); }
  async getClassMap() { return { ...this.classMap }; }
  async setClassMap(m: Record<string, string>) { this.classMap = { ...m }; }
  async getItemMap() { return { ...this.itemMap }; }
  async setItemMap(m: Record<string, string>) { this.itemMap = { ...m }; }
  async getSettings() { return { ...this.settings }; }
  async saveConnection(s: { realmId: string; companyName: string; environment: string }, now: Date) {
    const changed = this.settings.realmId !== null && (this.settings.realmId !== s.realmId || this.settings.environment !== s.environment);
    if (changed) { this.links.clear(); this.refs.clear(); this.jobs = []; this.flags = []; }
    this.settings = { ...s, connectedAt: now, syncFrom: this.settings.realmId === null || changed || !this.settings.syncFrom ? now : this.settings.syncFrom };
    return { companyChanged: changed };
  }
  async clearConnection() { /* keeps links and syncFrom so reconnecting the same company continues where it left off */ }

  async getInvoice(id: string) { return this.invoices.find((i) => i.id === id) ?? null; }
  async invoiceLines(id: string) { return this.invoiceLineRows.get(id) ?? []; }
  async getPayment(id: string) { return this.payments.find((p) => p.id === id) ?? null; }
  async liveInvoiceForJob(jobId: string) { return this.invoices.find((i) => i.jobId === jobId && i.status === "issued") ?? null; }
  async invoiceIdsMissingJob(since: Date, limit: number) {
    return this.invoices.filter((i) => i.issuedAt >= since && !this.jobs.some((j) => j.kind === "invoice" && j.entityId === i.id)).slice(0, limit).map((i) => i.id);
  }
  async paymentIdsMissingJob(since: Date, limit: number) {
    return this.payments.filter((p) => p.receivedAt >= since && !this.jobs.some((j) => j.kind === "payment" && j.entityId === p.id)).slice(0, limit).map((p) => p.id);
  }
  async voidedInvoiceIdsMissingVoidJob(limit: number) {
    return this.invoices.filter((i) => i.status === "void" && this.jobs.some((j) => j.kind === "invoice" && j.entityId === i.id) && !this.jobs.some((j) => j.kind === "void_invoice" && j.entityId === i.id)).slice(0, limit).map((i) => i.id);
  }
  async voidedPaymentIdsMissingVoidJob(limit: number) {
    return this.payments.filter((p) => p.voidedAt && this.jobs.some((j) => j.kind === "payment" && j.entityId === p.id) && !this.jobs.some((j) => j.kind === "void_payment" && j.entityId === p.id)).slice(0, limit).map((p) => p.id);
  }
}
