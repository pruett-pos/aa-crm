import type { Division } from "../rules.ts";
import type { JobStageOrClosed, TradeStatus } from "../production/types.ts";

export type WorkOrderStatus = "draft" | "issued";

/** One task on a work order. There is deliberately no price, cost or rate here. */
export type WorkOrderLine = {
  id: string;
  sortOrder: number;
  /** The scope line it came from; null when the estimator added it by hand. */
  sourceItemId: string | null;
  description: string;
  quantity: number;
  unit: string;
  note: string | null;
};

export type WorkOrder = {
  id: string;
  jobId: string;
  division: Division;
  status: WorkOrderStatus;
  notes: string | null;
  createdAt: Date;
  issuedAt: Date | null;
  lines: WorkOrderLine[];
};

export type WorkOrderJob = {
  id: string;
  jobNumber: number;
  stage: JobStageOrClosed;
  estimatorId: string | null;
  divisions: Division[];
  address: string;
  contractSigned: boolean;
};

export type WorkOrderTrade = {
  division: Division;
  status: TradeStatus;
  installDate: string | null;
  crewLeaderId: string | null;
  crewLeaderName: string | null;
};

/** A labor or other line of the chosen package, as it will be copied onto the work order. */
export type SourceLine = { itemId: string; description: string; quantity: number; unit: string };
/** A material of the chosen package with its color, for the crew's copy (no price). */
export type MaterialLine = { description: string; unit: string; quantity: number; color: string | null };

export type NewLine = { sourceItemId: string | null; description: string; quantity: number; unit: string; note: string | null };

/** Everything done to one job's work orders runs inside this, with the job locked. */
export interface WorkOrderTx {
  getJob(): Promise<WorkOrderJob | null>;
  listOrders(): Promise<WorkOrder[]>;
  /** Labor and other lines of the chosen package for a trade. Empty when no package is chosen. */
  sourceLines(division: Division): Promise<SourceLine[]>;
  /** How many material lines of the chosen package still have no color. */
  colorsMissing(division: Division): Promise<number>;
  insertOrder(division: Division, lines: NewLine[], actorId: string | null): Promise<void>;
  setNotes(orderId: string, notes: string | null): Promise<void>;
  addLine(orderId: string, line: NewLine): Promise<void>;
  setLineNote(orderId: string, lineId: string, note: string | null): Promise<boolean>;
  /** Only a hand-added line (no source) can be removed. */
  removeHandLine(orderId: string, lineId: string): Promise<boolean>;
  setStatus(orderId: string, status: WorkOrderStatus, actorId: string | null, at: Date): Promise<void>;
}

export interface WorkOrderStore {
  getJob(jobId: string): Promise<WorkOrderJob | null>;
  listTrades(jobId: string): Promise<WorkOrderTrade[]>;
  pmDivisions(userId: string): Promise<Division[]>;
  listOrders(jobId: string): Promise<WorkOrder[]>;
  materials(jobId: string, division: Division): Promise<MaterialLine[]>;
  /** How many material lines of the chosen package for this trade still have no color. */
  colorsMissing(jobId: string, division: Division): Promise<number>;
  /** The job's estimator, for the "colors needed" email. */
  estimatorContact(jobId: string): Promise<{ email: string; name: string } | null>;
  /** Signed jobs whose chosen packages still have material lines without a color (not yet ordered, not closed). */
  jobsNeedingColors(): Promise<{ jobId: string; missing: number }[]>;
  transaction<T>(jobId: string, fn: (tx: WorkOrderTx) => Promise<T>): Promise<T>;
}
