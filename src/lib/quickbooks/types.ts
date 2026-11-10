import type { Division } from "../rules.ts";

export type SyncKind = "invoice" | "payment" | "void_invoice" | "void_payment";
export type SyncStatus = "pending" | "waiting" | "running" | "done" | "failed" | "cancelled";

export type SyncJob = {
  id: string;
  kind: SyncKind;
  entityId: string;
  status: SyncStatus;
  attempts: number;
  nextAttemptAt: Date;
  lockedAt: Date | null;
  lastError: string | null;
  qboId: string | null;
  /** Sent to QuickBooks as RequestId. Fixed for the life of the job, so a retry can never create a second copy. */
  requestId: string;
  payload: InvoicePayload | null;
  crmTotalCents: number | null;
  qboTotalCents: number | null;
  mismatch: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type SyncPatch = Partial<Pick<SyncJob,
  "status" | "attempts" | "nextAttemptAt" | "lastError" | "qboId" | "requestId" | "qboTotalCents" | "mismatch" | "lockedAt">>;

export type NewSyncJob = { kind: SyncKind; entityId: string; payload?: InvoicePayload | null; crmTotalCents?: number | null };

/** What the invoice said when it was issued, frozen when the push is queued: one line per trade. */
export type InvoicePayload = { lines: { division: Division; description: string; amountCents: number }[] };

export type CrmCustomer = { id: string; firstName: string; lastName: string; email: string | null; phone: string | null };
export type CrmAddress = { street: string; city: string; state: string; zip: string };

export type CrmInvoice = {
  id: string;
  jobId: string;
  jobNumber: number;
  invoiceNumber: number;
  issuedAt: Date;
  dueOn: string;                 // YYYY-MM-DD
  contractCents: number;
  status: "issued" | "void";
  /** CRM lead source (the enum value, like "phone"). */
  source: string;
  customer: CrmCustomer;
  property: CrmAddress;
};

export type CrmPayment = {
  id: string;
  jobId: string;
  jobNumber: number;
  amountCents: number;
  method: string;
  reference: string | null;
  isDeposit: boolean;
  receivedAt: Date;
  voidedAt: Date | null;
  customer: CrmCustomer;
};

export type Link = { qboId: string; parentQboId: string | null };
export type LinkType = "customer" | "invoice" | "payment";

export type QboSettings = {
  realmId: string | null;
  companyName: string | null;
  environment: string | null;
  connectedAt: Date | null;
  /** Only invoices issued and payments received from this moment on are pushed (old history is never sent by accident). */
  syncFrom: Date | null;
};

/** The queue, the links, the mappings, and read access to the CRM records being pushed. */
export interface QboStore {
  // --- outbox
  /** Idempotent on (kind, entityId): asking twice returns the same job. */
  enqueue(j: NewSyncJob, now: Date): Promise<SyncJob>;
  getJob(id: string): Promise<SyncJob | null>;
  findJob(kind: SyncKind, entityId: string): Promise<SyncJob | null>;
  /** Takes up to `limit` jobs that are due (pending or waiting; a "running" job older than staleMs counts as abandoned) and marks them running. */
  claimDue(now: Date, limit: number, staleMs: number): Promise<SyncJob[]>;
  updateJob(id: string, patch: SyncPatch, now: Date): Promise<void>;
  listJobs(f: { statuses?: SyncStatus[]; mismatchOnly?: boolean; limit: number }): Promise<SyncJob[]>;
  counts(): Promise<Record<SyncStatus, number> & { mismatch: number }>;

  // --- links to QuickBooks records, cached ids, mappings, settings
  getLink(t: LinkType, entityId: string): Promise<Link | null>;
  setLink(t: LinkType, entityId: string, qboId: string, parentQboId?: string | null): Promise<void>;
  deleteLink(t: LinkType, entityId: string): Promise<void>;
  paymentIdsLinkedToInvoice(invoiceQboId: string): Promise<string[]>;
  getRef(kind: string, key: string): Promise<string | null>;
  setRef(kind: string, key: string, qboId: string): Promise<void>;
  getClassMap(): Promise<Record<string, string>>;
  setClassMap(m: Record<string, string>): Promise<void>;
  getItemMap(): Promise<Record<string, string>>;
  setItemMap(m: Record<string, string>): Promise<void>;
  getSettings(): Promise<QboSettings>;
  saveConnection(s: { realmId: string; companyName: string; environment: string }, now: Date): Promise<{ companyChanged: boolean }>;
  clearConnection(): Promise<void>;

  // --- reading the CRM
  getInvoice(id: string): Promise<CrmInvoice | null>;
  invoiceLines(invoiceId: string): Promise<InvoicePayload["lines"]>;
  getPayment(id: string): Promise<CrmPayment | null>;
  liveInvoiceForJob(jobId: string): Promise<CrmInvoice | null>;
  /** Things the sweep must queue. All limited to records on or after `since`. */
  invoiceIdsMissingJob(since: Date, limit: number): Promise<string[]>;
  paymentIdsMissingJob(since: Date, limit: number): Promise<string[]>;
  voidedInvoiceIdsMissingVoidJob(limit: number): Promise<string[]>;
  voidedPaymentIdsMissingVoidJob(limit: number): Promise<string[]>;
}
