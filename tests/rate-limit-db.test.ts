import { test } from "node:test";
import assert from "node:assert/strict";
import { allowPersistent, createMemoryRateLimitStore, createSqlRateLimitStore, hashKey, HIT_SQL, type RateLimitStore } from "../src/lib/auth/rate-limit-db.ts";
import { setLogSinks } from "../src/lib/ops/log.ts";

const T = new Date("2026-11-10T12:00:00Z");
const at = (ms: number) => new Date(T.getTime() + ms);

test("allows up to the limit inside a window, then refuses", async () => {
  const s = createMemoryRateLimitStore();
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await allowPersistent(s, "login:email:a@x.com", 5, 60_000, at(i)));
  assert.deepEqual(results, [true, true, true, true, true, false, false]);
});

test("a new window starts fresh; other keys are independent", async () => {
  const s = createMemoryRateLimitStore();
  for (let i = 0; i < 6; i++) await allowPersistent(s, "k", 5, 60_000, T);
  assert.equal(await allowPersistent(s, "k", 5, 60_000, at(59_999)), false);
  assert.equal(await allowPersistent(s, "k", 5, 60_000, at(60_000)), true);
  assert.equal(await allowPersistent(s, "other", 5, 60_000, T), true);
});

test("survives a restart: the count lives in the store, not in the limiter", async () => {
  const store = createMemoryRateLimitStore();
  for (let i = 0; i < 5; i++) await allowPersistent(store, "k", 5, 60_000, T);
  // "deploy": a new caller over the same store
  assert.equal(await allowPersistent(store, "k", 5, 60_000, at(1000)), false);
});

test("the key is stored hashed, never in clear", async () => {
  const s = createMemoryRateLimitStore();
  await allowPersistent(s, "login:email:secret@x.com", 5, 60_000, T);
  const keys = [...s.rows.keys()];
  assert.equal(keys.length, 1);
  assert.equal(keys[0], hashKey("login:email:secret@x.com"));
  assert.ok(!keys[0].includes("secret"));
});

test("if the store fails the limiter fails open and logs it (a missing table must not lock everyone out)", async () => {
  const lines: string[] = [];
  setLogSinks({ error: (l) => lines.push(l) });
  const broken: RateLimitStore = { async hit() { throw new Error('relation "rate_limits" does not exist'); } };
  assert.equal(await allowPersistent(broken, "k", 5, 60_000, T), true);
  assert.equal(JSON.parse(lines[0]).event, "rate_limit.store_failed");
});

test("the SQL store sends one atomic upsert and returns the count it gets back", async () => {
  const calls: { text: string; params: unknown[] }[] = [];
  const store = createSqlRateLimitStore(async (text, params) => { calls.push({ text, params }); return [{ hits: 3 }]; }, () => 0.5);
  assert.equal(await store.hit("abc", 60_000, T), 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, HIT_SQL);
  assert.match(HIT_SQL, /ON CONFLICT \(key\) DO UPDATE/);
  assert.deepEqual(calls[0].params, ["abc", at(60_000).toISOString(), T.toISOString()]);
});

test("the SQL store tidies expired rows now and then, and a failed tidy never breaks a hit", async () => {
  const texts: string[] = [];
  const store = createSqlRateLimitStore(async (text) => { texts.push(text); if (text.startsWith("DELETE")) throw new Error("x"); return [{ hits: 1 }]; }, () => 0.0);
  assert.equal(await store.hit("abc", 60_000, T), 1);
  assert.ok(texts.some((t) => t.startsWith("DELETE FROM rate_limits")));
});
