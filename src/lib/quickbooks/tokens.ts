import { QboError } from "../../integrations/quickbooks/errors.ts";
import type { FetchLike } from "../../integrations/quickbooks/client.ts";
import { refreshQboTokens, type QboConfig, type QboTokens } from "../../integrations/quickbooks/oauth.ts";

export type StoredQboTokens = QboTokens & { status: "connected" | "needs_reconnect"; connectedBy: string | null; updatedAt: Date };

/**
 * Where QuickBooks' tokens live. A refresh REPLACES the refresh token, so refreshes take turns: `withLock` gives one caller
 * at a time, and the new token is saved before anyone else can read.
 */
export interface QboTokenStore {
  get(): Promise<StoredQboTokens | null>;
  withLock<T>(fn: (current: StoredQboTokens | null, w: { save(t: QboTokens): Promise<void>; markNeedsReconnect(): Promise<void> }) => Promise<T>): Promise<T>;
  connect(t: QboTokens, connectedBy: string | null): Promise<void>;
  disconnect(): Promise<void>;
}

const SKEW_MS = 120_000;   // refresh a little early so a token never expires mid-request

export type TokenManagerDeps = { store: QboTokenStore; config: QboConfig; fetch: FetchLike; now?: () => Date };

/** A function that returns a usable access token, refreshing when it is about to expire or when asked (after a 401). */
export function createQboTokenProvider(d: TokenManagerDeps) {
  const now = d.now ?? (() => new Date());
  return async function getAccessToken(forceRefresh: boolean): Promise<string> {
    const seen = await d.store.get();
    if (!seen) throw new QboError("auth", "QuickBooks isn't connected");
    if (seen.status === "needs_reconnect") throw new QboError("auth", "QuickBooks needs to be connected again");
    if (!forceRefresh && seen.expiresAt.getTime() - now().getTime() > SKEW_MS) return seen.accessToken;

    // A failure is RETURNED out of the locked section, not thrown: a throw would roll the transaction back and undo the
    // "needs reconnect" flag.
    const result = await d.store.withLock(async (locked, w): Promise<{ token: string } | { failure: QboError }> => {
      if (!locked) throw new QboError("auth", "QuickBooks isn't connected");
      if (locked.status === "needs_reconnect") throw new QboError("auth", "QuickBooks needs to be connected again");
      // Someone else refreshed while we waited: use their token instead of spending the refresh token twice.
      if (locked.accessToken !== seen.accessToken) return { token: locked.accessToken };
      if (!forceRefresh && locked.expiresAt.getTime() - now().getTime() > SKEW_MS) return { token: locked.accessToken };
      try {
        const t = await refreshQboTokens(d.config, locked.refreshToken, locked.realmId, d.fetch, now());
        await w.save(t);
        return { token: t.accessToken };
      } catch (e) {
        if (e instanceof QboError && e.kind === "auth") {
          await w.markNeedsReconnect();
          return { failure: e };
        }
        throw e;
      }
    });
    if ("failure" in result) throw result.failure;
    return result.token;
  };
}
