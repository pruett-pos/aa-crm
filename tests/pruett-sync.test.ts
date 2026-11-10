import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryCatalogStore } from "../src/lib/catalog/memory-store.ts";
import { MAX_AUTO_CHANGE_BPS, applyPriceSync, feedProblem, planPriceSync } from "../src/lib/catalog/sync.ts";
import { PruettError, fetchPruettPrices, pruettConfigFromEnv, type PruettFeed } from "../src/integrations/pruett/client.ts";
import { pruettPriceCents } from "../src/lib/rules.ts";

const feedOf = (items: [string, number][], over: Partial<PruettFeed> = {}): PruettFeed => ({
  level: "Builder", levelNotSet: false, generatedAt: "2026-11-10T00:00:00Z",
  items: items.map(([sku, retailCents]) => ({ sku, description: null, unit: null, retailCents })), ...over,
});
async function seeded(rows: [string, number][]) {
  const s = new MemoryCatalogStore();
  for (const [sku, retailCents] of rows) await s.create({ sku, name: `Item ${sku}`, unit: "ea", retailCents, specialOrder: sku === "SO" });
  return s;
}

test("sync updates retail by SKU ignoring case, and Builder cost follows from rules.ts", async () => {
  const store = await seeded([["SHG-HL", 13_500], ["RIDGE", 4_000]]);
  const plan = planPriceSync(await store.list(), feedOf([["shg-hl", 14_000], ["RIDGE", 4_000], ["OTHER", 100]]));
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.feedOnly, 1);
  assert.equal(await applyPriceSync(store, plan), 1);
  const shg = (await store.list()).find((p) => p.sku === "SHG-HL")!;
  assert.equal(shg.retailCents, 14_000);
  assert.equal(pruettPriceCents(shg.retailCents), 12_320);   // retail 140.00 - 12%
});

test("sync never adds or removes products and keeps name, unit and special-order", async () => {
  const store = await seeded([["SO", 1_000], ["GONE", 500]]);
  const before = (await store.list()).map((p) => ({ ...p }));
  const plan = planPriceSync(before, feedOf([["SO", 1_100], ["NEW", 900]]));
  assert.deepEqual(plan.notInFeed, ["GONE"]);
  await applyPriceSync(store, plan);
  const after = await store.list();
  assert.equal(after.length, 2);
  const so = after.find((p) => p.sku === "SO")!;
  const was = before.find((p) => p.sku === "SO")!;
  assert.deepEqual({ ...so, retailCents: was.retailCents }, was);
  assert.equal(after.find((p) => p.sku === "GONE")!.retailCents, 500);
});

test("a move over 50% is held, not applied; exactly 50% is applied", async () => {
  assert.equal(MAX_AUTO_CHANGE_BPS, 5000);
  const store = await seeded([["A", 1_000], ["B", 1_000], ["C", 1_000]]);
  const plan = planPriceSync(await store.list(), feedOf([["A", 1_500], ["B", 1_501], ["C", 400]]));
  assert.deepEqual(plan.changes.map((c) => c.sku), ["A"]);
  assert.deepEqual(plan.held.map((c) => c.sku).sort(), ["B", "C"]);
  await applyPriceSync(store, plan);
  const m = Object.fromEntries((await store.list()).map((p) => [p.sku, p.retailCents]));
  assert.deepEqual(m, { A: 1_500, B: 1_000, C: 1_000 });
});

test("an empty feed or an unset Builder level is refused", () => {
  assert.equal(feedProblem(feedOf([])), "empty_feed");
  assert.equal(feedProblem(feedOf([["A", 1]], { levelNotSet: true })), "level_not_set");
  assert.equal(feedProblem(feedOf([["A", 1]])), null);
});

const body = (over: Record<string, unknown> = {}) => ({
  level: "Builder", level_not_set: false, generated_at: "2026-11-10T00:00:00Z", count: 2,
  items: [
    { sku: " SHG-HL ", description: "Shingles", description2: null, unit: "SQ", category: null, vendor: null, vendor_sku: null, price_cents: 11_880, retail_cents: 13_500, active: true },
    { sku: "X", description: "Old", unit: "EA", price_cents: 0, retail_cents: 1, active: false },
  ], ...over,
});
const cfgWith = (res: () => Response | Promise<Response>, calls: { url?: string; auth?: string | null }[] = []) => ({
  baseUrl: "https://pos.test/api", apiKey: "k-123",
  fetch: async (url: string, init?: RequestInit) => { calls.push({ url, auth: new Headers(init?.headers).get("authorization") }); return res(); },
});
const kind = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof PruettError ? e.kind : "other"; } };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

test("client sends the bearer key to /feed/prices, reads retail only, skips inactive, trims SKUs", async () => {
  const calls: { url?: string; auth?: string | null }[] = [];
  const feed = await fetchPruettPrices(cfgWith(() => json(body()), calls), "Builder");
  assert.equal(calls[0].url, "https://pos.test/api/feed/prices?level=Builder");
  assert.equal(calls[0].auth, "Bearer k-123");
  assert.deepEqual(feed.items, [{ sku: "SHG-HL", description: "Shingles", unit: "SQ", retailCents: 13_500 }]);
});

test("client maps feed errors to clear kinds", async () => {
  const t = (res: () => Response | Promise<Response>) => kind(fetchPruettPrices(cfgWith(res)));
  assert.equal(await t(() => json({}, 401)), "auth");
  assert.equal(await t(() => json({}, 503)), "disabled");
  assert.equal(await t(() => json({}, 404)), "level_not_found");
  assert.equal(await t(() => json({}, 500)), "server");
  assert.equal(await t(() => { throw new Error("down"); }), "network");
  assert.equal(await t(() => new Response("not json", { status: 200 })), "bad_response");
  assert.equal(await t(() => json(body({ count: 5 }))), "bad_response");          // cut off
  assert.equal(await t(() => json(body({ level: "Wholesale" }))), "bad_response");
});

test("config comes from the environment, and is null without a key", () => {
  assert.equal(pruettConfigFromEnv({}), null);
  assert.equal(pruettConfigFromEnv({ PRUETT_POS_API_URL: "https://x/api" }), null);
  assert.deepEqual(pruettConfigFromEnv({ PRUETT_POS_API_URL: "https://x/api/", PRUETT_POS_API_KEY: " k " }), { baseUrl: "https://x/api", apiKey: "k" });
});
