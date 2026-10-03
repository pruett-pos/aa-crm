import type { Division, Stage } from "../rules.ts";
import type { Role } from "../auth/roles.ts";
import type { StoredScope } from "../scopes/types.ts";

export const TRADE_STATUSES = ["not_scheduled", "proposed", "scheduled", "in_production", "complete"] as const;
export type TradeStatus = (typeof TRADE_STATUSES)[number];

export type JobStageOrClosed = Stage | "lost" | "cancelled_after_approval";

export type ProductionJob = {
  id: string;
  jobNumber: number;
  stage: JobStageOrClosed;
  estimatorId: string | null;
  divisions: Division[];
  customerName: string;
  propertyAddress: string;
  contractSigned: boolean;
  depositRequiredCents: number;
  depositPaidCents: number;
  materialsOrderedAt: Date | null;
  poReference: string | null;
};

export type TradeRow = {
  division: Division;
  status: TradeStatus;
  installDate: string | null;          // YYYY-MM-DD
  crewLeaderId: string | null;
  crewLeaderName: string | null;
  proposedBy: string | null;
  confirmedBy: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  notes: string | null;
};

export type TradePatch = Partial<Omit<TradeRow, "division" | "crewLeaderName">>;

export type Actor = { id: string; role: Role };

export type ScheduleItem = {
  jobId: string;
  jobNumber: number;
  division: Division;
  status: TradeStatus;
  installDate: string | null;
  crewLeaderId: string | null;
  crewLeaderName: string | null;
  customerName: string;
  propertyAddress: string;
  estimatorId: string | null;
};

export type ProductEntry = { id: string; name: string; unit: string; specialOrder: boolean };

/** Everything done to one job's production state runs inside this, with the job locked. */
export interface ProductionTx {
  getJob(): Promise<ProductionJob | null>;
  listTrades(): Promise<TradeRow[]>;
  upsertTrade(division: Division, patch: TradePatch): Promise<void>;
  logEvent(e: { division: Division | null; actorId: string; action: string; detail?: string }): Promise<void>;
  setStage(from: JobStageOrClosed, to: Stage, actorId: string): Promise<void>;
  setMaterialsOrder(at: Date, byUserId: string, poReference: string, notes: string | null): Promise<void>;
  setJobInstallDate(date: string | null): Promise<void>;
  /** Ids of the material lines on the chosen packages of this job. */
  chosenMaterialItemIds(): Promise<Set<string>>;
  setColors(items: { itemId: string; color: string | null }[]): Promise<void>;
  /** Other trades (any job) the crew leader is confirmed for on that date. */
  crewConflicts(crewLeaderId: string, date: string, except: { jobId: string; division: Division }): Promise<{ jobNumber: number; division: Division }[]>;
}

export interface ProductionStore {
  getJob(jobId: string): Promise<ProductionJob | null>;
  listTrades(jobId: string): Promise<TradeRow[]>;
  pmDivisions(userId: string): Promise<Division[]>;
  listCrewLeaders(): Promise<{ id: string; fullName: string }[]>;
  isActiveCrewLeader(userId: string): Promise<boolean>;
  getChosenScopes(jobId: string): Promise<StoredScope[]>;
  listProducts(): Promise<ProductEntry[]>;
  listSchedule(range: { from: string; to: string }): Promise<ScheduleItem[]>;
  /** Trades that still need a date or a crew, any date. */
  listOpenTrades(): Promise<ScheduleItem[]>;
  transaction<T>(jobId: string, fn: (tx: ProductionTx) => Promise<T>): Promise<T>;
}
