import type { ScopeStore } from "./types.ts";
import { createPrismaScopeStore } from "./prisma-store.ts";
import { getDb } from "../db.ts";

const g = globalThis as unknown as { __aaScopeStore?: ScopeStore };

/** Scopes need the database; there is no in-memory fallback outside tests. */
export function getScopeStore(): ScopeStore {
  return (g.__aaScopeStore ??= createPrismaScopeStore(getDb()));
}
