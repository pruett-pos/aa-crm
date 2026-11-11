import type { Product } from "../scopes/types.ts";
import { CatalogError, type CatalogStore, type ValidProduct } from "./service.ts";
import { STALE_RUN_MS, type PriceChange, type PriceSyncPlan, type SyncProduct, type SyncRun, type SyncRunStore } from "./price-sync.ts";

type Rec = Product & { description2: string | null; category: string | null; vendor: string | null; vendorSku: string | null };
export type MemoryPriceHistory = PriceChange & { productId: string; changedAt: Date; runId: number | null };

/** In-memory catalog for tests. `usedIds` stands in for "a scope line or roofing assembly points at this product". */
export class MemoryCatalogStore implements CatalogStore {
  products: Rec[] = [];
  history: MemoryPriceHistory[] = [];
  /** Set by a test to stamp history rows. */
  now: () => Date = () => new Date();
  usedIds = new Set<string>();
  private n = 0;

  private taken(sku: string, exceptId?: string) {
    return this.products.some((p) => p.id !== exceptId && p.sku.toLowerCase() === sku.toLowerCase());
  }

  async list() {
    return [...this.products].sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(p: ValidProduct) {
    if (this.taken(p.sku)) throw new CatalogError("duplicate_sku", "That SKU is already in the catalog");
    const rec: Rec = { id: `p${++this.n}`, ...p, costCents: null, active: true, source: "manual", description2: null, category: null, vendor: null, vendorSku: null };
    this.products.push(rec);
    return { ...rec };
  }

  async update(id: string, p: ValidProduct) {
    const i = this.products.findIndex((x) => x.id === id);
    if (i < 0) throw new CatalogError("not_found");
    if (this.taken(p.sku, id)) throw new CatalogError("duplicate_sku", "That SKU is already in the catalog");
    this.products[i] = { ...this.products[i], id, ...p };
    return { ...this.products[i] };
  }

  async remove(id: string) {
    const i = this.products.findIndex((x) => x.id === id);
    if (i < 0) throw new CatalogError("not_found");
    if (this.usedIds.has(id)) throw new CatalogError("in_use", "A scope or a roofing assembly still uses this product");
    this.products.splice(i, 1);
  }

  async listForSync(): Promise<SyncProduct[]> {
    return this.products.map((p) => ({
      id: p.id, sku: p.sku, name: p.name, unit: p.unit, retailCents: p.retailCents, costCents: p.costCents ?? null, active: p.active !== false,
      source: p.source === "pruett" ? "pruett" : "manual", description2: p.description2, category: p.category, vendor: p.vendor, vendorSku: p.vendorSku,
    }));
  }

  async applyPriceSync(plan: PriceSyncPlan, runId: number | null) {
    for (const c of plan.creates) {
      const { sku, ...f } = c;
      this.products.push({ id: `p${++this.n}`, sku, specialOrder: false, active: true, source: "pruett", ...f });
    }
    for (const u of plan.updates) {
      const i = this.products.findIndex((x) => x.id === u.id);
      if (i < 0) continue;
      this.products[i] = { ...this.products[i], ...u.fields, active: true, source: "pruett" };
      if (u.price) this.history.push({ ...u.price, productId: u.id, changedAt: this.now(), runId });
    }
    for (const id of plan.deactivateIds) {
      const p = this.products.find((x) => x.id === id);
      if (p) p.active = false;
    }
  }
}

/** In-memory run log for tests. */
export class MemorySyncRunStore implements SyncRunStore {
  runs: SyncRun[] = [];
  private n = 0;

  async start(trigger: SyncRun["trigger"], userId: string | null, now: Date) {
    for (const r of this.runs) {
      if (r.status === "running" && now.getTime() - r.startedAt.getTime() >= STALE_RUN_MS) { r.status = "error"; r.finishedAt = now; r.error = "The run never finished"; }
    }
    if (this.runs.some((r) => r.status === "running")) return null;
    const run: SyncRun = { id: ++this.n, startedAt: now, finishedAt: null, trigger, triggeredBy: userId, status: "running", itemsSeen: 0, itemsNew: 0, itemsChanged: 0, itemsDeactivated: 0, warning: null, error: null };
    this.runs.push(run);
    return { ...run };
  }

  async finish(id: number, status: Exclude<SyncRun["status"], "running">, result: Parameters<SyncRunStore["finish"]>[2], now: Date) {
    const r = this.runs.find((x) => x.id === id)!;
    Object.assign(r, result, { status, finishedAt: now });
    return { ...r };
  }

  async latest() {
    const r = this.runs[this.runs.length - 1];
    return r ? { ...r } : null;
  }
}
