import type { Division } from "../rules.ts";
import type { ClaimFact, JobFact, ReportStore, SpendRow } from "./types.ts";

/** In-memory store for tests. Not used by the app. */
export class MemoryReportStore implements ReportStore {
  facts: JobFact[] = [];
  spend: SpendRow[] = [];
  claims: ClaimFact[] = [];
  names: Record<string, string> = {};
  pm = new Map<string, Division[]>();

  async listJobFacts() { return this.facts; }
  async listSpend(from: string, to: string) { return this.spend.filter((s) => s.month >= from && s.month <= to); }
  async listClaims() { return this.claims; }
  async estimatorNames() { return this.names; }
  async pmDivisions(userId: string) { return this.pm.get(userId) ?? []; }
}
