import type { AssemblyLine } from "./assemblies.ts";
import type { AssemblyEdit, AssemblyStore } from "./service.ts";

/** In-memory assembly settings for tests. Not used by the app. */
export class MemoryAssemblyStore implements AssemblyStore {
  rows: (AssemblyLine & { updatedBy: string | null })[] = [];
  async list() { return this.rows.map(({ updatedBy: _u, ...r }) => { void _u; return { ...r }; }); }
  async upsert(e: AssemblyEdit & { kind: "material" | "labor" }, userId: string) {
    const row = { tier: e.tier, role: e.role, kind: e.kind, productId: e.productId, description: e.description, unit: e.unit, coverage: e.coverage, unitCostCents: e.unitCostCents, enabled: e.enabled, sortOrder: e.sortOrder ?? 0, updatedBy: userId };
    const i = this.rows.findIndex((r) => r.tier === e.tier && r.role === e.role);
    if (i >= 0) this.rows[i] = { ...row, sortOrder: e.sortOrder ?? this.rows[i].sortOrder };
    else this.rows.push(row);
  }
}
