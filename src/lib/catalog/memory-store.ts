import type { Product } from "../scopes/types.ts";
import { CatalogError, type CatalogStore, type ValidProduct } from "./service.ts";

/** In-memory catalog for tests. `usedIds` stands in for "a scope line or roofing assembly points at this product". */
export class MemoryCatalogStore implements CatalogStore {
  products: Product[] = [];
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
    const rec: Product = { id: `p${++this.n}`, ...p };
    this.products.push(rec);
    return { ...rec };
  }

  async update(id: string, p: ValidProduct) {
    const i = this.products.findIndex((x) => x.id === id);
    if (i < 0) throw new CatalogError("not_found");
    if (this.taken(p.sku, id)) throw new CatalogError("duplicate_sku", "That SKU is already in the catalog");
    this.products[i] = { id, ...p };
    return { ...this.products[i] };
  }

  async remove(id: string) {
    const i = this.products.findIndex((x) => x.id === id);
    if (i < 0) throw new CatalogError("not_found");
    if (this.usedIds.has(id)) throw new CatalogError("in_use", "A scope or a roofing assembly still uses this product");
    this.products.splice(i, 1);
  }
}
