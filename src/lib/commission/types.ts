import type { Schedule } from "./periods.ts";

export type EntryKind = "earned" | "reversal" | "adjustment";

export type LedgerEntry = {
  id: string;
  estimatorId: string;
  jobId: string | null;
  jobNumber: number | null;
  paymentId: string | null;
  kind: EntryKind;
  rateBps: number | null;
  marginBps: number | null;
  amountCents: number;
  entryDate: string;         // local date, YYYY-MM-DD
  runId: string | null;
  paidOn: string | null;
  note: string | null;
};

export type NewEntry = Omit<LedgerEntry, "id" | "jobNumber" | "runId" | "paidOn">;

export type Draw = { id: string; estimatorId: string; amountCents: number; paidOn: string; appliedCents: number; note: string | null };
export type Run = {
  id: string; estimatorId: string; periodStart: string; periodEnd: string;
  grossCents: number; drawsAppliedCents: number; netCents: number; paidOn: string; note: string | null;
};
export type EstimatorRow = { id: string; fullName: string; ownTruck: boolean; active: boolean };

/** Work done while one estimator's rows are locked, so two payouts can't both pay the same entries. */
export interface CommissionTx {
  hasRun(periodEnd: string): Promise<boolean>;
  unpaidEntries(throughDate: string): Promise<LedgerEntry[]>;
  outstandingDraws(): Promise<Draw[]>;
  createRun(r: Omit<Run, "id">, entryIds: string[], applications: { drawId: string; amountCents: number }[], createdBy: string): Promise<Run>;
  insertDraw(d: Omit<Draw, "id" | "appliedCents">, createdBy: string): Promise<Draw>;
  insertAdjustment(e: NewEntry, createdBy: string): Promise<LedgerEntry>;
}

export interface CommissionStore {
  getSchedule(): Promise<Schedule | null>;
  setSchedule(s: Schedule, userId: string): Promise<void>;
  getEstimator(id: string): Promise<EstimatorRow | null>;
  listEstimators(): Promise<EstimatorRow[]>;
  listEntries(estimatorId: string, limit: number): Promise<LedgerEntry[]>;
  listDraws(estimatorId: string): Promise<Draw[]>;
  listRuns(estimatorId: string): Promise<Run[]>;
  unpaidThrough(estimatorId: string, throughDate: string): Promise<number>;
  /** Payments on jobs with an estimator that have no commission entry (job had no known margin). */
  uncommissionedPaymentCount(): Promise<number>;
  transaction<T>(estimatorId: string, fn: (tx: CommissionTx) => Promise<T>): Promise<T>;
}
