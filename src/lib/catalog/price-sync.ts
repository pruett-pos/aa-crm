import type { PruettClient, PruettFeed, PruettFeedItem } from "../../integrations/pruett/client.ts";
import { PruettError } from "../../integrations/pruett/client.ts";
import { MAX_RETAIL_CENTS, type CatalogStore } from "./service.ts";

// Nightly Pruett price sync. Pruett POS is the source of truth for the products it lists; this file decides what changes
// (pure, so it is easy to test) and records every run. Products are only ever written through the CatalogStore.
// Money is integer cents. A&A's cost is Pruett's price_cents at our level (Builder = retail - 12%); retail is kept for display.

export type SyncProduct = {
  id: string; sku: string; name: string; unit: string; retailCents: number; costCents: number | null; active: boolean;
  source: "manual" | "pruett"; description2: string | null; category: string | null; vendor: string | null; vendorSku: string | null;
};

export type PruettFields = {
  name: string; unit: string; retailCents: number; costCents: number; description2: string | null; category: string | null;
  vendor: string | null; vendorSku: string | null;
};
export type PriceChange = { oldCostCents: number | null; newCostCents: number; oldRetailCents: number; newRetailCents: number };

export type PriceSyncPlan = {
  creates: ({ sku: string } & PruettFields)[];
  /** Always sets active = true and source = pruett. `price` is set only when a price actually changed (and goes to the history). */
  updates: { id: string; fields: PruettFields; price: PriceChange | null }[];
  deactivateIds: string[];
  /** Price moves over MAX_AUTO_CHANGE_BPS: not applied, listed in a warning for a person to look at. */
  held: { sku: string; from: number; to: number }[];
  warnings: string[];
  seen: number;
};

/** A move bigger than this is far more likely a bad import at Pruett than a real change, so it waits for a person. */
export const MAX_AUTO_CHANGE_BPS = 5000;   // 50%
const movedTooFar = (from: number | null, to: number) => from !== null && from > 0 && Math.abs(to - from) * 10000 > from * MAX_AUTO_CHANGE_BPS;

export const MAX_SKU_LENGTH = 60;
const lower = (s: string) => s.toLowerCase();

/** Pruett units are free text ("BDL", "SQ", "PC/2"). The catalog wants 1 to 8 lower-case letters, so keep the letters. */
export function normalizeUnit(raw: string): string {
  return lower(raw).replace(/[^a-z]/g, "").slice(0, 8) || "ea";
}
export function normalizeName(description: string, sku: string): string {
  const n = description.trim().replace(/\s+/g, " ").slice(0, 120);
  return n.length >= 2 ? n : sku;
}

function fieldsOf(it: PruettFeedItem): PruettFields {
  return {
    name: normalizeName(it.description, it.sku), unit: normalizeUnit(it.unit), retailCents: it.retailCents, costCents: it.priceCents,
    description2: it.description2, category: it.category, vendor: it.vendor, vendorSku: it.vendorSku,
  };
}

/**
 * What to do with the catalog for this feed:
 *  - match on SKU (ignoring case); add the ones we don't have; update prices and details; record price changes
 *  - a Pruett product missing from the feed (or marked inactive) becomes inactive...
 *  - ...unless the feed has fewer than half of our currently active Pruett products. That looks like a broken or partial
 *    feed, so prices still update and new items still come in, but nothing is deactivated, and a warning says so.
 * Hand-entered products (source = manual) that Pruett doesn't list are never touched. One that matches a Pruett SKU is adopted.
 */
export function planPriceSync(existing: SyncProduct[], feed: PruettFeed): PriceSyncPlan {
  const warnings: string[] = [];
  const bySku = new Map(existing.map((p) => [lower(p.sku), p]));

  // The feed, one row per SKU. The first row wins; a repeat is a Pruett data problem worth a warning.
  const rows = new Map<string, PruettFeedItem>();
  let duplicates = 0;
  let tooLong = 0;
  for (const it of feed.items) {
    if (it.sku.length > MAX_SKU_LENGTH || it.priceCents > MAX_RETAIL_CENTS || it.retailCents > MAX_RETAIL_CENTS) { tooLong++; continue; }
    if (rows.has(lower(it.sku))) { duplicates++; continue; }
    rows.set(lower(it.sku), it);
  }
  const skipped = feed.skippedItems + tooLong;
  if (skipped > 0) warnings.push(`${skipped} feed item(s) were skipped because the SKU or price was not usable`);
  if (duplicates > 0) warnings.push(`${duplicates} feed item(s) repeated a SKU and were ignored`);

  // Everything Pruett lists, even rows we could not use: those must not look "missing" and get deactivated.
  const listed = new Set([...feed.items.map((i) => lower(i.sku)), ...feed.skippedSkus.map(lower)]);

  const creates: PriceSyncPlan["creates"] = [];
  const updates: PriceSyncPlan["updates"] = [];
  const held: PriceSyncPlan["held"] = [];
  const wantInactive = new Set<string>();   // ids Pruett says to deactivate (missing, or marked inactive)

  for (const [key, it] of rows) {
    const cur = bySku.get(key);
    if (!it.active) {
      if (cur && cur.source === "pruett" && cur.active) wantInactive.add(cur.id);
      continue;                                  // an item Pruett has switched off is not added
    }
    const f = fieldsOf(it);
    if (!cur) { creates.push({ sku: it.sku, ...f }); continue; }
    // A new price that jumped more than 50% is held: nothing about that product changes tonight.
    if (movedTooFar(cur.retailCents, f.retailCents) || movedTooFar(cur.costCents, f.costCents)) {
      held.push({ sku: cur.sku, from: cur.retailCents, to: f.retailCents });
      continue;
    }
    const priceChanged = cur.costCents !== f.costCents || cur.retailCents !== f.retailCents;
    const detailsChanged = cur.name !== f.name || cur.unit !== f.unit || cur.description2 !== f.description2 || cur.category !== f.category
      || cur.vendor !== f.vendor || cur.vendorSku !== f.vendorSku || !cur.active || cur.source !== "pruett";
    if (priceChanged || detailsChanged) {
      updates.push({
        id: cur.id, fields: f,
        price: priceChanged ? { oldCostCents: cur.costCents, newCostCents: f.costCents, oldRetailCents: cur.retailCents, newRetailCents: f.retailCents } : null,
      });
    }
  }
  for (const p of existing) if (p.source === "pruett" && p.active && !listed.has(lower(p.sku))) wantInactive.add(p.id);

  // Safety rule: compare what the feed lists (as active) with what we currently have active from Pruett.
  const activeBefore = existing.filter((p) => p.source === "pruett" && p.active).length;
  const activeInFeed = new Set([...feed.items.filter((i) => i.active).map((i) => lower(i.sku)), ...feed.skippedSkus.map(lower)]).size;
  let deactivateIds = [...wantInactive];
  if (activeBefore > 0 && activeInFeed * 2 < activeBefore) {
    warnings.push(`Pruett feed has only ${activeInFeed} items but ${activeBefore} Pruett products are active (less than half). Prices were updated; nothing was deactivated`);
    deactivateIds = [];
  }
  if (held.length > 0) {
    const shown = held.slice(0, 5).map((h) => `${h.sku} ($${(h.from / 100).toFixed(2)} to $${(h.to / 100).toFixed(2)})`).join(", ");
    warnings.push(`${held.length} price(s) moved more than 50% and were held for a person to check: ${shown}${held.length > 5 ? ", ..." : ""}`);
  }
  return { creates, updates, deactivateIds, held, warnings, seen: feed.count };
}

// ---------- Schedule ----------

/** Railway cron runs on UTC and has no time zone, so the cron service fires at 07:00 and 08:00 UTC and this picks the one that is 2 AM in Central. */
export const SYNC_HOUR_CENTRAL = 2;
export function isSyncHourCentral(at: Date): boolean {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).formatToParts(at).find((p) => p.type === "hour")?.value;
  return Number(hour) === SYNC_HOUR_CENTRAL;
}

// ---------- Run log ----------

export type SyncTrigger = "cron" | "manual";
export type SyncStatus = "running" | "ok" | "warning" | "error";
export type SyncRun = {
  id: number; startedAt: Date; finishedAt: Date | null; trigger: SyncTrigger; triggeredBy: string | null; status: SyncStatus;
  itemsSeen: number; itemsNew: number; itemsChanged: number; itemsDeactivated: number; warning: string | null; error: string | null;
};
export type SyncRunResult = Pick<SyncRun, "itemsSeen" | "itemsNew" | "itemsChanged" | "itemsDeactivated" | "warning" | "error">;

/** A run that never finished (crashed container) stops blocking new runs after this long. */
export const STALE_RUN_MS = 30 * 60 * 1000;

export interface SyncRunStore {
  /** Starts a run, or returns null when another run is still going (so two never overlap). Old unfinished runs are closed as errors. */
  start(trigger: SyncTrigger, userId: string | null, now: Date): Promise<SyncRun | null>;
  finish(id: number, status: Exclude<SyncStatus, "running">, result: SyncRunResult, now: Date): Promise<SyncRun>;
  latest(): Promise<SyncRun | null>;
}

export type SyncDeps = { catalog: CatalogStore; runs: SyncRunStore; getClient: () => PruettClient };
export type SyncOptions = { trigger: SyncTrigger; userId?: string | null; now?: () => Date; log?: (line: string) => void };

/** Dry run: what a sync would do right now. Reads the feed and the catalog, writes nothing (no products, no run record). */
export async function previewPriceSync(deps: Pick<SyncDeps, "catalog" | "getClient">): Promise<PriceSyncPlan> {
  return planPriceSync(await deps.catalog.listForSync(), await deps.getClient().fetchPrices());
}

/** Runs one sync end to end and returns the finished run record. Never throws for a feed problem: that becomes an error run. */
export async function runPriceSync(deps: SyncDeps, opts: SyncOptions): Promise<SyncRun | { status: "busy" }> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((l: string) => console.log(l));
  const run = await deps.runs.start(opts.trigger, opts.userId ?? null, now());
  if (!run) { log("pruett sync: another run is in progress; skipped"); return { status: "busy" }; }
  log(`pruett sync: started (run ${run.id}, ${opts.trigger})`);

  const empty: SyncRunResult = { itemsSeen: 0, itemsNew: 0, itemsChanged: 0, itemsDeactivated: 0, warning: null, error: null };
  const done = async (status: "ok" | "warning" | "error", r: SyncRunResult) => {
    const finished = await deps.runs.finish(run.id, status, r, now());
    const line = `pruett sync: finished ${status} (seen ${r.itemsSeen}, new ${r.itemsNew}, changed ${r.itemsChanged}, deactivated ${r.itemsDeactivated})`;
    if (r.error) log(`${line} ERROR: ${r.error}`);
    else if (r.warning) log(`${line} WARNING: ${r.warning}`);
    else log(line);
    return finished;
  };

  try {
    const feed = await deps.getClient().fetchPrices();
    const plan = planPriceSync(await deps.catalog.listForSync(), feed);
    await deps.catalog.applyPriceSync(plan, run.id);
    return await done(plan.warnings.length ? "warning" : "ok", {
      itemsSeen: plan.seen, itemsNew: plan.creates.length, itemsChanged: plan.updates.length, itemsDeactivated: plan.deactivateIds.length,
      warning: plan.warnings.length ? plan.warnings.join("; ") : null, error: null,
    });
  } catch (e) {
    if (e instanceof PruettError) return done("error", { ...empty, error: e.message });
    console.error("pruett sync: unexpected failure", e);
    return done("error", { ...empty, error: "The sync failed unexpectedly. Nothing was changed; check the server log." });
  }
}

/** What the screen and API see of a run: dates as ISO text, and no user id. */
export function syncRunView(r: SyncRun) {
  return {
    id: r.id, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null, trigger: r.trigger, status: r.status,
    itemsSeen: r.itemsSeen, itemsNew: r.itemsNew, itemsChanged: r.itemsChanged, itemsDeactivated: r.itemsDeactivated, warning: r.warning, error: r.error,
  };
}
export type SyncRunView = ReturnType<typeof syncRunView>;
