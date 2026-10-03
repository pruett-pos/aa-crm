import type { Division } from "../rules.ts";

export type JobFact = {
  jobId: string;
  jobNumber: number;
  jobType: "retail" | "insurance" | "condition_report";
  divisions: Division[];          // first one is the primary division
  source: string;
  estimatorId: string | null;
  stage: string;
  createdDate: string;            // local (Central) date
  contractCents: number | null;
  wonDate: string | null;         // first time the job entered contract_signed; null if it never did
  inProductionDate: string | null;
  installDate: string | null;     // scheduled install date
  invoicedDate: string | null;
  collectedCents: number;         // non-voided payments
  depositRequiredCents: number;
  depositPaidCents: number;
};

export type SpendRow = { source: string; month: string; spendCents: number };

export type ClaimFact = {
  jobId: string;
  jobNumber: number;
  divisions: Division[];
  estimatorId: string | null;
  carrier: string | null;
  claimNumber: string | null;
  depreciationCents: number;
  depreciationReceivedAt: string | null;
};

export type CommissionBalance = { estimatorId: string; name: string; unpaidCents: number; drawsOutstandingCents: number };

export type DateRange = { from: string; to: string };

/** A report as a plain table, so the screen and the CSV download share one shape. */
export type ColumnKind = "text" | "int" | "money" | "percent" | "days";
export type ReportTable = {
  name: string;
  title: string;
  columns: { key: string; label: string; kind: ColumnKind }[];
  rows: Record<string, string | number | null>[];
  totals?: Record<string, string | number | null>;
  note?: string;
  /** Shown when there is nothing to report yet, naming what will fill the report. */
  emptyReason?: string;
};

export interface ReportStore {
  listJobFacts(): Promise<JobFact[]>;
  listSpend(fromMonth: string, toMonth: string): Promise<SpendRow[]>;
  listClaims(): Promise<ClaimFact[]>;
  estimatorNames(): Promise<Record<string, string>>;
  /** Divisions a Production Manager manages (any market). */
  pmDivisions(userId: string): Promise<Division[]>;
}
