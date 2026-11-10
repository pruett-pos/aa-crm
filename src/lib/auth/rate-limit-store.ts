import { getDb } from "../db.ts";
import { createSqlRateLimitStore, type RateLimitStore } from "./rate-limit-db.ts";
import { createMemoryRateLimitStore } from "./rate-limit-db.ts";

const g = globalThis as unknown as { __aaRateLimitStore?: RateLimitStore };

/** Postgres when DATABASE_URL is set; in memory for database-free local dev. */
export function getRateLimitStore(): RateLimitStore {
  if (g.__aaRateLimitStore) return g.__aaRateLimitStore;
  g.__aaRateLimitStore = process.env.DATABASE_URL
    ? createSqlRateLimitStore((text, params) => getDb().$queryRawUnsafe<Array<Record<string, unknown>>>(text, ...params))
    : createMemoryRateLimitStore();
  return g.__aaRateLimitStore;
}
