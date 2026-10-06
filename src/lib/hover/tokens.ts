import { HoverError, type FetchLike } from "../../integrations/hover/client.ts";
import { refreshHoverTokens, type HoverOAuthConfig, type HoverTokens } from "../../integrations/hover/oauth.ts";

export type StoredHoverTokens = HoverTokens & { status: "connected" | "needs_reconnect"; connectedBy: string | null; updatedAt: Date };

/**
 * Where Hover's tokens live. The refresh token ROTATES (each refresh invalidates the old one), so a refresh must be
 * done by one caller at a time and saved before anyone else can read: `withLock` gives that exclusive turn.
 */
export interface HoverTokenStore {
  get(): Promise<StoredHoverTokens | null>;
  /** Exclusive access. `current` is read after the lock is taken; `save` and `markNeedsReconnect` write inside it. */
  withLock<T>(fn: (current: StoredHoverTokens | null, w: { save(t: HoverTokens): Promise<void>; markNeedsReconnect(): Promise<void> }) => Promise<T>): Promise<T>;
  /** First connection (or a reconnect), after a person approved access in the browser. */
  connect(t: HoverTokens, connectedBy: string | null): Promise<void>;
  disconnect(): Promise<void>;
}

const SKEW_MS = 120_000;   // refresh a little early so a token never expires mid-request

export type TokenManagerDeps = { store: HoverTokenStore; oauth: HoverOAuthConfig; fetch: FetchLike; now?: () => Date };

/**
 * A function that returns a usable access token, refreshing when it is about to expire or when asked (after a 401).
 * Safe to call from many requests at once: only one refresh runs, the others reuse its result.
 */
export function createHoverTokenProvider(d: TokenManagerDeps) {
  const now = d.now ?? (() => new Date());
  return async function getAccessToken(forceRefresh: boolean): Promise<string> {
    const seen = await d.store.get();
    if (!seen) throw new HoverError("auth", "Hover isn't connected");
    if (seen.status === "needs_reconnect") throw new HoverError("auth", "Hover needs to be connected again");
    if (!forceRefresh && seen.expiresAt.getTime() - now().getTime() > SKEW_MS) return seen.accessToken;

    // A failure is RETURNED out of the locked section, not thrown: a throw would roll the database transaction back and
    // undo the "needs reconnect" flag, and every later request would try the spent refresh token again.
    const result = await d.store.withLock(async (locked, w): Promise<{ token: string } | { failure: HoverError }> => {
      if (!locked) throw new HoverError("auth", "Hover isn't connected");
      if (locked.status === "needs_reconnect") throw new HoverError("auth", "Hover needs to be connected again");
      // Someone else refreshed while we waited for our turn: use their new token instead of spending the refresh token again.
      if (locked.accessToken !== seen.accessToken) return { token: locked.accessToken };
      if (!forceRefresh && locked.expiresAt.getTime() - now().getTime() > SKEW_MS) return { token: locked.accessToken };
      try {
        const t = await refreshHoverTokens(d.oauth, locked.refreshToken, d.fetch, now());
        await w.save(t);
        return { token: t.accessToken };
      } catch (e) {
        // A refused refresh token can't be retried (it is spent or revoked): a person has to connect again.
        if (e instanceof HoverError && e.kind === "auth") {
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
