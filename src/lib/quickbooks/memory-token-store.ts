import type { QboTokens } from "../../integrations/quickbooks/oauth.ts";
import type { QboTokenStore, StoredQboTokens } from "./tokens.ts";

/** In-memory token store for tests. Not used by the app. */
export class MemoryQboTokenStore implements QboTokenStore {
  row: StoredQboTokens | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  lockCount = 0;

  async get() { return this.row ? { ...this.row } : null; }

  async withLock<T>(fn: Parameters<QboTokenStore["withLock"]>[0] extends (...a: infer A) => infer R ? (...a: A) => R : never): Promise<T> {
    const run = this.lock.then(async () => {
      this.lockCount++;
      const before = this.row ? { ...this.row } : null;
      try {
        return await fn(this.row ? { ...this.row } : null, {
          save: async (t: QboTokens) => { this.row = { ...t, status: "connected", connectedBy: this.row?.connectedBy ?? null, updatedAt: new Date() }; },
          markNeedsReconnect: async () => { if (this.row) this.row = { ...this.row, status: "needs_reconnect" }; },
        });
      } catch (e) {
        this.row = before;           // a throw rolls back, like a database transaction
        throw e;
      }
    });
    this.lock = run.catch(() => undefined);
    return run as Promise<T>;
  }

  async connect(t: QboTokens, connectedBy: string | null) { this.row = { ...t, status: "connected", connectedBy, updatedAt: new Date() }; }
  async disconnect() { this.row = null; }
}
