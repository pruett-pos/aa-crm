import type { Division, Stage } from "../rules.ts";

export const TIERS = ["good", "better", "best"] as const;
export type Tier = (typeof TIERS)[number];
export type LineKind = "material" | "labor" | "misc";

export type Product = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  retailCents: number;
  specialOrder: boolean;
};

/** What the estimator sends. Prices are never accepted from the client. */
export type ScopeInput = {
  division: Division;          // the trade this estimate is for; must be one of the job's divisions
  tier: Tier;
  title: string;
  targetMarginBps: number;
  items: ScopeItemInput[];
};
export type ScopeItemInput = {
  kind: LineKind;
  productId?: string;          // required for material lines
  description?: string;        // required for labor / misc lines
  quantity: number;
  unitCostCents?: number;      // labor / misc only; materials price from the catalog
  color?: string;
};

export type ComputedItem = {
  kind: LineKind;
  sortOrder: number;
  productId: string | null;
  description: string;
  quantity: number;
  unitCostCents: number;
  unitPriceCents: number;
  color: string | null;
};

export type ComputedScope = {
  division: Division;
  tier: Tier;
  title: string;
  targetMarginBps: number;
  items: ComputedItem[];
  costCents: number;
  saleCents: number;
  marginBps: number;
};

export type JobAccess = {
  id: string;
  stage: Stage;
  divisions: Division[];
  estimatorId: string | null;
  productionManagerId: string | null;
};

export type StoredScope = ComputedScope & { id: string; selected: boolean };

export type JobSummary = JobAccess & { jobNumber: number; jobType: "retail" | "insurance" | "condition_report" };

export interface ScopeStore {
  getJob(jobId: string): Promise<JobAccess | null>;
  /** All jobs, newest first. Callers filter with canReadScopes. */
  listJobs(): Promise<JobSummary[]>;
  /** User ids of Production Managers who manage any of these divisions. */
  divisionManagerIds(divisions: Division[]): Promise<string[]>;
  /** Divisions a Production Manager manages (any market). */
  divisionsManagedBy(userId: string): Promise<Division[]>;
  getEstimatorOwnTruck(userId: string): Promise<boolean>;
  listProducts(): Promise<Product[]>;
  listScopes(jobId: string): Promise<StoredScope[]>;
  /** Replace the scope for (jobId, division, tier), creating it if needed. */
  saveScope(jobId: string, scope: ComputedScope): Promise<StoredScope>;
}
