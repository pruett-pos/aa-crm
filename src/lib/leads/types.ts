import type { Division, Stage } from "../rules.ts";
import type { Market, PmRow } from "./routing.ts";

export const LEAD_SOURCES = [
  "phone", "demandiq", "website", "google_scheduling", "facebook", "referral", "canvassing", "other",
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const DIVISIONS: readonly Division[] = [
  "roofing", "siding", "gutters", "windows_doors", "insulation", "spray_foam", "commercial",
];
export const MARKETS: readonly Market[] = ["west_plains", "springfield", "nw_arkansas"];

export type LeadJobType = "retail" | "insurance";

export type CustomerRow = {
  id: string; firstName: string; lastName: string; phone: string | null; email: string | null;
  lastEstimatorId: string | null;
};
export type PropertyRow = { id: string; customerId: string; street: string; city: string; state: string; zip: string; market: Market };

export type CustomerHit = CustomerRow & {
  properties: (Omit<PropertyRow, "customerId"> & { jobs: { id: string; jobNumber: number; stage: string }[] })[];
};

export type NewJob = {
  propertyId: string; jobType: LeadJobType; divisions: Division[]; stage: Stage; source: LeadSource;
  needsReview: boolean; appointmentAt: Date | null; estimatorId: string | null;
  productionManagerId: string | null; createdBy: string | null;
};

export type ReviewJob = {
  id: string; jobNumber: number; needsReview: boolean; propertyId: string; customerId: string;
  lastEstimatorId: string | null; stage: string;
};

export type LeadListItem = {
  jobId: string; jobNumber: number; customerName: string; phone: string | null; street: string; city: string;
  market: Market; jobType: string; divisions: Division[]; source: LeadSource; stage: string;
  estimatorName: string | null; pmName: string | null; needsReview: boolean; needsAssignment: boolean; createdAt: Date;
};

export interface LeadTx {
  findCustomerByPhone(digits: string): Promise<CustomerRow | null>;
  getCustomer(id: string): Promise<CustomerRow | null>;
  createCustomer(c: { firstName: string; lastName: string; phone: string | null; phoneDigits: string | null; email: string | null }): Promise<CustomerRow>;
  getProperty(id: string): Promise<PropertyRow | null>;
  findPropertyByAddress(customerId: string, street: string, zip: string): Promise<PropertyRow | null>;
  createProperty(p: Omit<PropertyRow, "id">): Promise<PropertyRow>;
  createJob(j: NewJob): Promise<{ id: string; jobNumber: number }>;
  addHistory(jobId: string, from: string | null, to: Stage, by: string | null): Promise<void>;
  setLastEstimator(customerId: string, userId: string): Promise<void>;
  getReviewJob(jobId: string): Promise<ReviewJob | null>;
  updateReviewedJob(jobId: string, u: { jobType: LeadJobType; divisions: Division[]; estimatorId: string | null; productionManagerId: string | null }): Promise<void>;
  updatePropertyMarket(propertyId: string, market: Market): Promise<void>;
  logEvent(system: string, payload: unknown): Promise<void>;
}

export interface LeadStore {
  searchCustomers(q: { phoneDigits: string | null; text: string | null }): Promise<CustomerHit[]>;
  getPmRows(): Promise<PmRow[]>;
  isActiveEstimator(userId: string): Promise<boolean>;
  listEstimators(): Promise<{ id: string; fullName: string }[]>;
  listReviewQueue(): Promise<LeadListItem[]>;
  listLeads(limit: number): Promise<LeadListItem[]>;
  upsertSpend(source: LeadSource, month: string, spendCents: number): Promise<void>;
  listSpend(fromMonth: string, toMonth: string): Promise<{ source: LeadSource; month: string; spendCents: number }[]>;
  transaction<T>(fn: (tx: LeadTx) => Promise<T>): Promise<T>;
}
