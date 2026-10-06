import type { HoverTokens } from "../../integrations/hover/oauth.ts";
import type { HoverTokenStore, StoredHoverTokens } from "./tokens.ts";

/** In-memory token store for tests. Not used by the app. */
export class MemoryHoverTokenStore implements HoverTokenStore {
  row: StoredHoverTokens | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  /** How many times someone took the lock (tests check refreshes are serialized). */
  lockCount = 0;

  async get() { return this.row ? { ...this.row } : null; }

  async withLock<T>(fn: Parameters<HoverTokenStore["withLock"]>[0] extends (...a: infer A) => infer R ? (...a: A) => R : never): Promise<T> {
    const run = this.lock.then(async () => {
      this.lockCount++;
      const before = this.row ? { ...this.row } : null;
      try {
        return await fn(this.row ? { ...this.row } : null, {
          save: async (t: HoverTokens) => { this.row = { ...t, status: "connected", connectedBy: this.row?.connectedBy ?? null, updatedAt: new Date() }; },
          markNeedsReconnect: async () => { if (this.row) this.row = { ...this.row, status: "needs_reconnect" }; },
        });
      } catch (e) {
        this.row = before;           // a throw rolls everything written inside the lock back, like a database transaction
        throw e;
      }
    });
    this.lock = run.catch(() => undefined);
    return run as Promise<T>;
  }

  async connect(t: HoverTokens, connectedBy: string | null) { this.row = { ...t, status: "connected", connectedBy, updatedAt: new Date() }; }
  async disconnect() { this.row = null; }
}
