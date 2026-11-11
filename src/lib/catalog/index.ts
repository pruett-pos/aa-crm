import { getDb } from "../db.ts";
import { createPruettClient, pruettConfigFromEnv } from "../../integrations/pruett/client.ts";
import { createPrismaCatalogStore, createPrismaSyncRunStore } from "./prisma-store.ts";
import { previewPriceSync, runPriceSync, type SyncDeps, type SyncOptions, type SyncRunStore } from "./price-sync.ts";
import type { CatalogStore } from "./service.ts";

const g = globalThis as unknown as { __aaCatalogStore?: CatalogStore; __aaSyncRunStore?: SyncRunStore };

export function getCatalogStore(): CatalogStore {
  return (g.__aaCatalogStore ??= createPrismaCatalogStore(getDb()));
}

export function getSyncRunStore(): SyncRunStore {
  return (g.__aaSyncRunStore ??= createPrismaSyncRunStore(getDb()));
}

const realDeps = (): SyncDeps => ({ catalog: getCatalogStore(), runs: getSyncRunStore(), getClient: () => createPruettClient(pruettConfigFromEnv()) });

/** Dry run against the real feed and catalog: changes nothing. */
export const previewPruettSync = () => previewPriceSync(realDeps());

/** The real sync: Pruett feed from the environment, products and run log in the database. Used by the admin button and the cron script. */
export function runPruettSync(opts: SyncOptions) {
  return runPriceSync(realDeps(), opts);
}
