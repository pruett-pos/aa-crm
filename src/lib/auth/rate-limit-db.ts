// Fixed-window rate limiter kept in Postgres, so a deploy or restart does not reset the counts and several
// instances share them. Used for sign-in (the in-memory limiter in rate-limit.ts stays for the signed-in routes,
// where a reset on deploy is harmless and a database round trip per request is not worth it).
//
// The key is hashed before it is stored, so no email address or IP is kept in clear.
import { createHash } from "node:crypto";
import { logError } from "../ops/log.ts";

export type RateLimitStore = {
  /** Count one hit for `key` inside a window of `windowMs`; returns the hits so far in the current window. */
  hit(keyHash: string, windowMs: number, now: Date): Promise<number>;
};

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** True when this hit is within the limit. Fails OPEN (allows) if the store is unavailable, and logs it. */
export async function allowPersistent(store: RateLimitStore, key: string, limit: number, windowMs: number, now = new Date()): Promise<boolean> {
  try {
    return (await store.hit(hashKey(key), windowMs, now)) <= limit;
  } catch (e) {
    // Signing in already needs the database, so an outage stops it anyway. This only covers a missing table
    // (before db:migrate has run) so the app is not locked out by a limiter fault.
    logError("rate_limit.store_failed", e);
    return true;
  }
}

/** The one SQL statement: insert, or bump the counter, or start a fresh window when the old one ended. Atomic. */
export const HIT_SQL = `
  INSERT INTO rate_limits (key, hits, reset_at) VALUES ($1, 1, $2::timestamptz)
  ON CONFLICT (key) DO UPDATE SET
    hits     = CASE WHEN rate_limits.reset_at <= $3::timestamptz THEN 1 ELSE rate_limits.hits + 1 END,
    reset_at = CASE WHEN rate_limits.reset_at <= $3::timestamptz THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
  RETURNING hits`;
export const CLEANUP_SQL = "DELETE FROM rate_limits WHERE reset_at < $1::timestamptz";

type Query = (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;

/** Postgres-backed store over any query function (Prisma in the app, pg in tests). */
export function createSqlRateLimitStore(query: Query, random: () => number = Math.random): RateLimitStore {
  return {
    async hit(keyHash, windowMs, now) {
      const rows = await query(HIT_SQL, [keyHash, new Date(now.getTime() + windowMs).toISOString(), now.toISOString()]);
      // Tidy up expired rows now and then (about 1 call in 50) so the table stays small without a cron job.
      if (random() < 0.02) await query(CLEANUP_SQL, [new Date(now.getTime() - 24 * 3600 * 1000).toISOString()]).catch(() => undefined);
      return Number(rows[0]?.hits ?? 1);
    },
  };
}

/** In-memory store for tests. */
export function createMemoryRateLimitStore(): RateLimitStore & { rows: Map<string, { hits: number; resetAt: number }> } {
  const rows = new Map<string, { hits: number; resetAt: number }>();
  return {
    rows,
    async hit(keyHash, windowMs, now) {
      const r = rows.get(keyHash);
      if (!r || r.resetAt <= now.getTime()) {
        rows.set(keyHash, { hits: 1, resetAt: now.getTime() + windowMs });
        return 1;
      }
      r.hits += 1;
      return r.hits;
    },
  };
}
