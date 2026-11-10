import type { Product } from "../scopes/types.ts";
import type { PruettFeed } from "../../integrations/pruett/client.ts";
import { MAX_RETAIL_CENTS, type CatalogStore } from "./service.ts";

// Nightly Pruett price sync: keeps the RETAIL price of products already in the catalog current, matching on SKU
// (ignoring case). It only ever changes retailCents. It never adds or removes products (Pruett sells thousands of items,
// the catalog is the short list a scope can use) and never touches name, unit or the special-order flag.
// Scope lines copy their cost when a scope is built, so existing scopes keep the price they were built at.

/** A move bigger than this is far more likely a bad import at Pruett than a real change, so a person looks first. */
export const MAX_AUTO_CHANGE_BPS = 5000; // 50%

export type PriceChange = { id: string; sku: string; name: string; fromCents: number; toCents: number };
export type SyncPlan = {
  changes: PriceChange[];
  /** Over MAX_AUTO_CHANGE_BPS: listed, not applied. */
  held: PriceChange[];
  unchanged: number;
  /** Catalog products Pruett did not send (retired there, or a hand-made code). Never removed. */
  notInFeed: string[];
  /** Pruett items we do not carry in the catalog: just a count. */
  feedOnly: number;
};

export function planPriceSync(products: Product[], feed: PruettFeed): SyncPlan {
  const bySku = new Map(feed.items.map((i) => [i.sku.toLowerCase(), i]));
  const plan: SyncPlan = { changes: [], held: [], unchanged: 0, notInFeed: [], feedOnly: 0 };
  const seen = new Set<string>();
  for (const p of products) {
    const item = bySku.get(p.sku.toLowerCase());
    if (!item) { plan.notInFeed.push(p.sku); continue; }
    seen.add(p.sku.toLowerCase());
    if (item.retailCents === p.retailCents) { plan.unchanged++; continue; }
    const change = { id: p.id, sku: p.sku, name: p.name, fromCents: p.retailCents, toCents: item.retailCents };
    const tooBig = item.retailCents > MAX_RETAIL_CENTS ||
      Math.abs(item.retailCents - p.retailCents) * 10000 > p.retailCents * MAX_AUTO_CHANGE_BPS;
    (tooBig ? plan.held : plan.changes).push(change);
  }
  plan.feedOnly = [...bySku.keys()].filter((k) => !seen.has(k)).length;
  return plan;
}

export type SyncGuardError = "empty_feed" | "level_not_set";

/** Refuse to plan from a feed that cannot be trusted. Returns the reason, or null when fine. */
export function feedProblem(feed: PruettFeed): SyncGuardError | null {
  if (feed.items.length === 0) return "empty_feed";
  if (feed.levelNotSet) return "level_not_set";   // Builder % unset at Pruett: the CRM's 12% rule would no longer match what A&A is charged
  return null;
}

export async function applyPriceSync(store: CatalogStore, plan: SyncPlan): Promise<number> {
  return plan.changes.length ? store.updateRetailPrices(plan.changes.map((c) => ({ id: c.id, retailCents: c.toCents }))) : 0;
}
