import type { Division, Stage } from "../rules.ts";
import type { JobStageOrClosed, TradeStatus } from "../production/types.ts";

export type CloseoutJob = {
  id: string;
  jobNumber: number;
  jobType: "retail" | "insurance" | "condition_report";
  stage: JobStageOrClosed;
  estimatorId: string | null;
  divisions: Division[];
  customerName: string;
  customerEmail: string | null;
  propertyAddress: string;
  contractCents: number | null;
  contractSigned: boolean;
};

/** Just what rights checks need about a trade. */
export type CloseoutTrade = { division: Division; status: TradeStatus; crewLeaderId: string | null };

export type PunchItem = {
  id: string;
  division: Division | null;          // null = the whole job
  labelEn: string;
  labelRu: string | null;
  sortOrder: number;
  done: boolean;
  doneBy: string | null;
  doneAt: Date | null;
};
export type NewPunchItem = { division: Division | null; labelEn: string; labelRu: string | null };

export type InvoiceStatus = "issued" | "void";
export type InvoiceRow = {
  id: string;
  jobId: string;
  invoiceNumber: number;
  issuedAt: Date;
  dueOn: string;                      // YYYY-MM-DD
  contractCents: number;
  paidCents: number;
  balanceCents: number;
  status: InvoiceStatus;
  issuedBy: string | null;
  emailedTo: string | null;
  emailedAt: Date | null;
  emailStatus: "sent" | "failed" | null;
  emailError: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
};

/** One line per trade on the invoice: the package the customer chose and its price. */
export type InvoiceSection = { division: Division; packageTitle: string; subtotalCents: number };

export type NewInvoice = {
  invoiceNumber: number;
  dueOn: string;
  contractCents: number;
  paidCents: number;
  balanceCents: number;
  issuedBy: string;
  issuedAt: Date;
  pdf: Uint8Array;
  pdfSha256: string;
};

/** Everything done to one job's closeout state runs inside this, with the job locked. */
export interface CloseoutTx {
  getJob(): Promise<CloseoutJob | null>;
  listTrades(): Promise<CloseoutTrade[]>;
  listItems(): Promise<PunchItem[]>;
  insertItems(items: NewPunchItem[], actorId: string): Promise<void>;
  updateItem(id: string, patch: { done?: boolean; labelEn?: string; labelRu?: string | null }, actorId: string, at: Date): Promise<boolean>;
  deleteItem(id: string): Promise<boolean>;
  /** Live (not voided) payments added up. */
  collectedCents(): Promise<number>;
  chosenSections(): Promise<InvoiceSection[]>;
  liveInvoice(): Promise<InvoiceRow | null>;
  /** The next sequential invoice number (the PDF shows it, so it is taken before the invoice is saved). */
  nextInvoiceNumber(): Promise<number>;
  insertInvoice(i: NewInvoice): Promise<InvoiceRow>;
  voidInvoice(id: string, byUserId: string, reason: string, at: Date): Promise<boolean>;
  setStage(from: JobStageOrClosed, to: Stage, actorId: string): Promise<void>;
}

export interface CloseoutStore {
  getJob(jobId: string): Promise<CloseoutJob | null>;
  listTrades(jobId: string): Promise<CloseoutTrade[]>;
  pmDivisions(userId: string): Promise<Division[]>;
  listItems(jobId: string): Promise<PunchItem[]>;
  listInvoices(jobId: string): Promise<InvoiceRow[]>;
  /** Live (not voided) payments added up. */
  collectedCents(jobId: string): Promise<number>;
  getInvoice(id: string): Promise<InvoiceRow | null>;
  getInvoicePdf(id: string): Promise<Uint8Array | null>;
  /** Record the outcome of emailing an invoice (kept apart from issuing, so a failed email never loses the invoice). */
  recordEmail(id: string, e: { to: string; status: "sent" | "failed"; error: string | null; at: Date }): Promise<void>;
  transaction<T>(jobId: string, fn: (tx: CloseoutTx) => Promise<T>): Promise<T>;
}
