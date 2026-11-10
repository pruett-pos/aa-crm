import { getDb } from "../db.ts";
import { createQboClient, type QboClient } from "../../integrations/quickbooks/client.ts";
import { qboApiBase, qboConfigFromEnv, type QboConfig } from "../../integrations/quickbooks/oauth.ts";
import { runQueue, sweep, type Tally } from "./logic.ts";
import { createPrismaQboStore } from "./prisma-store.ts";
import { createPrismaQboTokenStore } from "./token-store.ts";
import { createQboTokenProvider, type QboTokenStore } from "./tokens.ts";
import type { QboStore } from "./types.ts";

const g = globalThis as unknown as { __aaQboTokens?: QboTokenStore; __aaQboStore?: QboStore; __aaQboBusy?: boolean };

export const getQboConfig = (): QboConfig | null => qboConfigFromEnv();
export const getQboTokenStore = (): QboTokenStore => (g.__aaQboTokens ??= createPrismaQboTokenStore(getDb(), () => process.env.INTEGRATION_KEY));
export const getQboStore = (): QboStore => (g.__aaQboStore ??= createPrismaQboStore(getDb()));

/** A client for the connected company, or null when QuickBooks isn't configured or connected. */
export async function getQboClient(): Promise<QboClient | null> {
  const config = getQboConfig();
  if (!config) return null;
  const stored = await getQboTokenStore().get().catch(() => null);
  if (!stored?.realmId) return null;
  return createQboClient({
    apiBase: qboApiBase(config.environment), realmId: stored.realmId,
    getAccessToken: createQboTokenProvider({ store: getQboTokenStore(), config, fetch: (u, i) => fetch(u, i) }),
  });
}

/** Queue anything new, then work through what is due. Used by the "Sync now" button and the cron script. */
export async function syncNow(limit = 25): Promise<(Tally & { queued: number }) | null> {
  const client = await getQboClient();
  if (!client) return null;
  const store = getQboStore();
  const { queued } = await sweep(store);
  return { ...(await runQueue({ store, client }, { limit })), queued };
}

/**
 * Called right after an invoice is issued or voided or a payment is recorded or voided. It never delays or breaks the
 * request: the push runs in the background, and the cron script picks up anything that didn't finish.
 */
export function triggerQboSync(): void {
  if (g.__aaQboBusy || !getQboConfig()) return;
  g.__aaQboBusy = true;
  void (async () => {
    try { await syncNow(10); } catch (e) { console.error(`quickbooks background sync failed: ${e instanceof Error ? e.name : "unknown"}`); }
    finally { g.__aaQboBusy = false; }
  })();
}
