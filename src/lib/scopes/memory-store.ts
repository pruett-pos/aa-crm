import type { Division } from "../rules.ts";
import type {
  ComputedScope, JobAccess, Product, ScopeStore, StoredScope,
} from "./types.ts";

/** In-memory store for tests. Not used by the app. */
export class MemoryScopeStore implements ScopeStore {
  jobs: JobAccess[] = [];
  products: Product[] = [];
  managers: { division: Division; userId: string }[] = [];
  ownTruck = new Map<string, boolean>();
  scopes: (StoredScope & { jobId: string })[] = [];
  private seq = 0;

  async getJob(jobId: string) {
    return this.jobs.find((j) => j.id === jobId) ?? null;
  }
  async listJobs() {
    return this.jobs.map((j, i) => ({ ...j, jobNumber: i + 1, jobType: "retail" as const }));
  }
  async divisionManagerIds(divisions: Division[]) {
    return this.managers.filter((m) => divisions.includes(m.division)).map((m) => m.userId);
  }
  async divisionsManagedBy(userId: string) {
    return this.managers.filter((m) => m.userId === userId).map((m) => m.division);
  }
  async getEstimatorOwnTruck(userId: string) {
    return this.ownTruck.get(userId) ?? false;
  }
  async listProducts() {
    return this.products;
  }
  async listScopes(jobId: string) {
    return this.scopes.filter((s) => s.jobId === jobId);
  }
  async saveScope(jobId: string, scope: ComputedScope) {
    const existing = this.scopes.find((s) => s.jobId === jobId && s.division === scope.division && s.tier === scope.tier);
    const stored = { ...scope, id: existing?.id ?? `scope-${++this.seq}`, jobId, selected: existing?.selected ?? false };
    this.scopes = this.scopes.filter((s) => s !== existing).concat(stored);
    return stored;
  }
}
