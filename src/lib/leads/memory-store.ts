import type { Division, Stage } from "../rules.ts";
import type { Market, PmRow } from "./routing.ts";
import type {
  CustomerHit, CustomerRow, LeadListItem, LeadSource, LeadStore, LeadTx, NewJob, PropertyRow, ReviewJob,
} from "./types.ts";

type JobRec = NewJob & { id: string; jobNumber: number; createdAt: Date };

/** In-memory store for tests. Not used by the app. */
export class MemoryLeadStore implements LeadStore {
  customers: (CustomerRow & { phoneDigits: string | null })[] = [];
  properties: PropertyRow[] = [];
  jobs: JobRec[] = [];
  history: { jobId: string; from: string | null; to: Stage; by: string | null }[] = [];
  events: { system: string; payload: unknown }[] = [];
  pms: PmRow[] = [];
  estimators: { id: string; fullName: string }[] = [];
  spend = new Map<string, number>();
  private seq = 0;

  async searchCustomers(q: { phoneDigits: string | null; text: string | null }): Promise<CustomerHit[]> {
    const text = q.text?.toLowerCase();
    const hits = this.customers.filter((c) => {
      if (q.phoneDigits) return c.phoneDigits !== null && c.phoneDigits.endsWith(q.phoneDigits);
      const props = this.properties.filter((p) => p.customerId === c.id);
      return [`${c.firstName} ${c.lastName}`, ...props.map((p) => p.street)].some((s) => s.toLowerCase().includes(text ?? "\u0000"));
    });
    return hits.slice(0, 15).map(({ phoneDigits: _d, ...c }) => ({
      ...c,
      properties: this.properties.filter((p) => p.customerId === c.id).map(({ customerId: _c, ...p }) => ({
        ...p, jobs: this.jobs.filter((j) => j.propertyId === p.id).map((j) => ({ id: j.id, jobNumber: j.jobNumber, stage: j.stage })),
      })),
    }));
  }
  async getPmRows() { return this.pms; }
  async isActiveEstimator(id: string) { return this.estimators.some((e) => e.id === id); }
  async listEstimators() { return this.estimators; }

  private item(j: JobRec): LeadListItem {
    const p = this.properties.find((x) => x.id === j.propertyId)!;
    const c = this.customers.find((x) => x.id === p.customerId)!;
    return {
      jobId: j.id, jobNumber: j.jobNumber, customerName: `${c.firstName} ${c.lastName}`, phone: c.phone,
      street: p.street, city: p.city, market: p.market, jobType: j.jobType, divisions: j.divisions, source: j.source,
      stage: j.stage, estimatorName: this.estimators.find((e) => e.id === j.estimatorId)?.fullName ?? null,
      pmName: j.productionManagerId, needsReview: j.needsReview,
      needsAssignment: !j.estimatorId && !j.productionManagerId, createdAt: j.createdAt,
    };
  }
  async listReviewQueue() { return this.jobs.filter((j) => j.needsReview).map((j) => this.item(j)); }
  async listLeads(limit: number) { return this.jobs.slice(-limit).reverse().map((j) => this.item(j)); }
  async upsertSpend(source: LeadSource, month: string, cents: number) { this.spend.set(`${source}|${month}`, cents); }
  async listSpend(from: string, to: string) {
    return [...this.spend].map(([k, spendCents]) => {
      const [source, month] = k.split("|");
      return { source: source as LeadSource, month, spendCents };
    }).filter((r) => r.month >= from && r.month <= to);
  }

  async transaction<T>(fn: (tx: LeadTx) => Promise<T>): Promise<T> {
    const self = this;
    // Roll back on error, like a real transaction.
    const snapshot = {
      customers: self.customers.map((c) => ({ ...c })), properties: self.properties.map((p) => ({ ...p })),
      jobs: self.jobs.map((j) => ({ ...j })), history: [...self.history], events: [...self.events],
    };
    const tx: LeadTx = {
      async findCustomerByPhone(d) {
        const c = self.customers.find((x) => x.phoneDigits === d);
        return c ? stripC(c) : null;
      },
      async getCustomer(id) {
        const c = self.customers.find((x) => x.id === id);
        return c ? stripC(c) : null;
      },
      async createCustomer(c) {
        const row = { id: `c-${++self.seq}`, firstName: c.firstName, lastName: c.lastName, phone: c.phone, email: c.email, lastEstimatorId: null, phoneDigits: c.phoneDigits };
        self.customers.push(row);
        return stripC(row);
      },
      async getProperty(id) { return self.properties.find((p) => p.id === id) ?? null; },
      async findPropertyByAddress(customerId, street, zip) {
        return self.properties.find((p) => p.customerId === customerId && p.zip === zip && p.street.toLowerCase() === street.toLowerCase()) ?? null;
      },
      async createProperty(p) {
        const row = { id: `p-${++self.seq}`, ...p };
        self.properties.push(row);
        return row;
      },
      async createJob(j) {
        const rec: JobRec = { ...j, id: `j-${++self.seq}`, jobNumber: self.jobs.length + 1, createdAt: new Date() };
        self.jobs.push(rec);
        return { id: rec.id, jobNumber: rec.jobNumber };
      },
      async addHistory(jobId, from, to, by) { self.history.push({ jobId, from, to, by }); },
      async setLastEstimator(customerId, userId) {
        const c = self.customers.find((x) => x.id === customerId);
        if (c) c.lastEstimatorId = userId;
      },
      async getReviewJob(jobId): Promise<ReviewJob | null> {
        const j = self.jobs.find((x) => x.id === jobId);
        if (!j) return null;
        const p = self.properties.find((x) => x.id === j.propertyId)!;
        const c = self.customers.find((x) => x.id === p.customerId)!;
        return { id: j.id, jobNumber: j.jobNumber, needsReview: j.needsReview, propertyId: p.id, customerId: c.id, lastEstimatorId: c.lastEstimatorId, stage: j.stage };
      },
      async updateReviewedJob(jobId, u) {
        const j = self.jobs.find((x) => x.id === jobId)!;
        Object.assign(j, { jobType: u.jobType, divisions: u.divisions as Division[], estimatorId: u.estimatorId, productionManagerId: u.productionManagerId, needsReview: false });
      },
      async updatePropertyMarket(propertyId, market: Market) {
        const p = self.properties.find((x) => x.id === propertyId);
        if (p) p.market = market;
      },
      async logEvent(system, payload) { self.events.push({ system, payload }); },
    };
    try {
      return await fn(tx);
    } catch (e) {
      Object.assign(self, snapshot);
      throw e;
    }
  }
}

const stripC = ({ phoneDigits: _d, ...c }: CustomerRow & { phoneDigits: string | null }): CustomerRow => c;
