import { test } from "node:test";
import assert from "node:assert/strict";
import { PruettError, createPruettClient, pruettConfigFromEnv, type FetchLike } from "../src/integrations/pruett/client.ts";
import { MemoryCatalogStore, MemorySyncRunStore } from "../src/lib/catalog/memory-store.ts";
import { isSyncHourCentral, previewPriceSync, runPriceSync, type SyncRun } from "../src/lib/catalog/price-sync.ts";
import { materialUnitCostCents, pruettPriceCents } from "../src/lib/rules.ts";

// A fake Pruett POS. `feed.items` is what it serves; `feed.status` / `feed.body` override the whole answer.
const KEY = "feed-secret-key-123";
type Row = Record<string, unknown>;
const row = (sku: string, retail: number, over: Row = {}): Row => ({
  sku, description: `Item ${sku}`, description2: null, unit: "SQ", category: "Roofing", vendor: "Malarkey", vendor_sku: `V-${sku}`,
  price_cents: pruettPriceCents(retail), retail_cents: retail, active: true, ...over,
});
function setup(items: Row[] = []) {
  const feed = { items, status: 200, level_not_set: false, level: "Builder", count: undefined as number | undefined, body: undefined as unknown };
  const calls: { url: string; init: RequestInit }[] = [];
  const f: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    if (feed.status !== 200) return new Response(JSON.stringify({ error: "nope" }), { status: feed.status });
    const body = feed.body ?? {
      level: feed.level, level_not_set: feed.level_not_set, generated_at: "2026-11-10T08:00:00Z",
      count: feed.count ?? feed.items.length, items: feed.items,
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const catalog = new MemoryCatalogStore();
  const runs = new MemorySyncRunStore();
  const client = createPruettClient({ baseUrl: "https://pruett.test/", key: KEY, level: "Builder", fetch: f });
  const sync = (trigger: "cron" | "manual" = "cron") =>
    runPriceSync({ catalog, runs, getClient: () => client }, { trigger, log: () => undefined }) as Promise<SyncRun>;
  return { feed, calls, catalog, runs, sync };
}
const skus = (c: MemoryCatalogStore) => c.products.map((p) => p.sku).sort();
const find = (c: MemoryCatalogStore, sku: string) => c.products.find((p) => p.sku === sku)!;

test("client: right URL, level and bearer key", async () => {
  const t = setup([row("A1", 10_000)]);
  await t.sync();
  assert.equal(t.calls[0].url, "https://pruett.test/api/feed/prices?level=Builder");
  assert.equal((t.calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
});

test("config: the feed URL and key are required; level defaults to Builder", () => {
  assert.throws(() => pruettConfigFromEnv({}), (e) => e instanceof PruettError && e.kind === "not_configured");
  assert.throws(() => pruettConfigFromEnv({ PRUETT_FEED_URL: "https://x" }), PruettError);
  assert.equal(pruettConfigFromEnv({ PRUETT_FEED_URL: "https://x", PRUETT_FEED_KEY: "k" }).level, "Builder");
  assert.equal(pruettConfigFromEnv({ PRUETT_FEED_URL: "https://x", PRUETT_FEED_KEY: "k", PRUETT_PRICE_LEVEL: "Contractor" }).level, "Contractor");
});

test("a new item is added with Pruett's price as the cost, and the run is logged", async () => {
  const t = setup([row("SHG-1", 13_500), row("RDG-1", 4_000, { unit: "BDL" })]);
  const run = await t.sync();
  assert.deepEqual(skus(t.catalog), ["RDG-1", "SHG-1"]);
  const p = find(t.catalog, "SHG-1");
  assert.equal(p.costCents, 11_880);            // price_cents, taken as sent
  assert.equal(p.retailCents, 13_500);
  assert.equal(p.source, "pruett");
  assert.equal(p.active, true);
  assert.equal(p.unit, "sq");
  assert.equal(find(t.catalog, "RDG-1").unit, "bdl");
  assert.equal(materialUnitCostCents(p), 11_880);
  assert.equal(run.status, "ok");
  assert.deepEqual([run.itemsSeen, run.itemsNew, run.itemsChanged, run.itemsDeactivated], [2, 2, 0, 0]);
  assert.ok(run.startedAt && run.finishedAt);
  assert.equal(run.error, null);
  assert.equal(t.runs.runs.length, 1);
});

test("the cost is Pruett's price_cents even when it is not exactly retail minus 12%", async () => {
  const t = setup([row("X", 10_001, { price_cents: 8_000 })]);
  await t.sync();
  assert.equal(materialUnitCostCents(find(t.catalog, "X")), 8_000);
});

test("a price change updates the product and keeps old -> new with the time", async () => {
  const t = setup([row("SHG-1", 13_500)]);
  await t.sync();
  t.feed.items = [row("SHG-1", 14_000)];
  const at = new Date("2026-11-11T08:00:00Z");
  t.catalog.now = () => at;
  const run = await t.sync();
  const p = find(t.catalog, "SHG-1");
  assert.equal(p.retailCents, 14_000);
  assert.equal(p.costCents, 12_320);
  assert.equal(t.catalog.history.length, 1);
  assert.deepEqual(t.catalog.history[0], { productId: p.id, changedAt: at, runId: run.id, oldCostCents: 11_880, newCostCents: 12_320, oldRetailCents: 13_500, newRetailCents: 14_000 });
  assert.deepEqual([run.itemsNew, run.itemsChanged], [0, 1]);
  // Same prices again: nothing changes and no new history.
  const again = await t.sync();
  assert.deepEqual([again.itemsNew, again.itemsChanged, again.itemsDeactivated], [0, 0, 0]);
  assert.equal(t.catalog.history.length, 1);
});

test("a hand-entered product with the same SKU is adopted and keeps its id and special-order flag", async () => {
  const t = setup([row("shg-1", 13_500)]);
  const mine = await t.catalog.create({ sku: "SHG-1", name: "Shingles", unit: "sq", retailCents: 12_000, specialOrder: true });
  await t.sync();
  assert.equal(t.catalog.products.length, 1);
  const p = t.catalog.products[0];
  assert.equal(p.id, mine.id);
  assert.equal(p.source, "pruett");
  assert.equal(p.specialOrder, true);
  assert.equal(p.retailCents, 13_500);
  assert.equal(t.catalog.history.length, 1);
  assert.equal(t.catalog.history[0].oldCostCents, null);
});

test("an item missing from the feed becomes inactive; one that comes back is active again", async () => {
  const items = Array.from({ length: 4 }, (_, i) => row(`S${i}`, 10_000));
  const t = setup(items);
  await t.sync();
  t.feed.items = items.slice(0, 3);                       // S3 is gone (3 of 4 is not less than half)
  const run = await t.sync();
  assert.equal(find(t.catalog, "S3").active, false);
  assert.equal(find(t.catalog, "S0").active, true);
  assert.equal(run.itemsDeactivated, 1);
  assert.equal(run.status, "ok");
  t.feed.items = items;
  await t.sync();
  assert.equal(find(t.catalog, "S3").active, true);
});

test("an item Pruett marks inactive is deactivated and a new inactive item is not added", async () => {
  const t = setup([row("A", 100), row("B", 100), row("C", 100)]);
  await t.sync();
  t.feed.items = [row("A", 100), row("B", 100), row("C", 100, { active: false }), row("D", 100, { active: false })];
  const run = await t.sync();
  assert.equal(find(t.catalog, "C").active, false);
  assert.equal(t.catalog.products.some((p) => p.sku === "D"), false);
  assert.equal(run.itemsDeactivated, 1);
});

test("products added by hand that Pruett does not list are left alone", async () => {
  const t = setup([row("A", 100)]);
  await t.catalog.create({ sku: "MINE", name: "Custom trim", unit: "ea", retailCents: 500, specialOrder: false });
  await t.sync();
  assert.equal(find(t.catalog, "MINE").active, true);
});

test("safety rule: a feed with fewer than half of the active Pruett items updates prices but deactivates nothing, with a warning", async () => {
  const items = Array.from({ length: 10 }, (_, i) => row(`S${i}`, 10_000));
  const t = setup(items);
  await t.sync();
  t.feed.items = [row("S0", 11_000), row("S1", 10_000), row("S2", 10_000), row("NEW", 500)];   // 4 items in the feed vs 10 active: less than half
  const run = await t.sync();
  assert.equal(t.catalog.products.filter((p) => p.active).length, 11);       // nothing deactivated, the new one came in
  assert.equal(find(t.catalog, "S0").retailCents, 11_000);                   // prices still updated
  assert.equal(find(t.catalog, "NEW").active, true);
  assert.equal(run.itemsDeactivated, 0);
  assert.equal(run.status, "warning");
  assert.match(run.warning ?? "", /less than half/);
});

test("safety rule: exactly half is fine and does deactivate", async () => {
  const items = Array.from({ length: 10 }, (_, i) => row(`S${i}`, 10_000));
  const t = setup(items);
  await t.sync();
  t.feed.items = items.slice(0, 5);
  const run = await t.sync();
  assert.equal(run.itemsDeactivated, 5);
  assert.equal(run.status, "ok");
});

test("safety rule: an empty feed deactivates nothing", async () => {
  const t = setup([row("A", 100), row("B", 100)]);
  await t.sync();
  t.feed.items = [];
  const run = await t.sync();
  assert.equal(t.catalog.products.every((p) => p.active), true);
  assert.equal(run.status, "warning");
});

test("401 from Pruett: an error run, nothing changed, and the key is not in the log", async () => {
  const t = setup([row("A", 100)]);
  await t.sync();
  t.feed.status = 401;
  t.feed.items = [row("A", 999)];
  const run = await t.sync();
  assert.equal(run.status, "error");
  assert.match(run.error ?? "", /rejected the feed key/);
  assert.equal(JSON.stringify(run).includes(KEY), false);
  assert.equal(find(t.catalog, "A").retailCents, 100);
  assert.deepEqual([run.itemsSeen, run.itemsNew, run.itemsChanged, run.itemsDeactivated], [0, 0, 0, 0]);
  assert.ok(run.finishedAt);
});

test("level_not_set: stops with the Pruett message and changes nothing", async () => {
  const t = setup([row("A", 100), row("B", 100)]);
  await t.sync();
  t.feed.level_not_set = true;
  t.feed.items = [];
  const run = await t.sync();
  assert.equal(run.status, "error");
  assert.equal(run.error, "Builder % not set in Pruett POS");
  assert.equal(t.catalog.products.every((p) => p.active), true);
});

test("a feed for the wrong level, or one cut short, is refused", async () => {
  const t = setup([row("A", 100)]);
  t.feed.level = "Wholesale";
  assert.match((await t.sync()).error ?? "", /not "Builder"/);
  t.feed.level = "Builder";
  t.feed.count = 5;
  const run = await t.sync();
  assert.equal(run.status, "error");
  assert.match(run.error ?? "", /said 5 items but sent 1/);
  assert.equal(t.catalog.products.length, 0);
});

test("a row with a bad price is skipped with a warning and is not treated as missing", async () => {
  const t = setup([row("A", 100), row("B", 100)]);
  await t.sync();
  t.feed.items = [row("A", 100), row("B", 100, { price_cents: 12.5 })];
  const run = await t.sync();
  assert.equal(find(t.catalog, "B").active, true);
  assert.equal(run.status, "warning");
  assert.match(run.warning ?? "", /skipped/);
});

test("network failure and a non-JSON answer are error runs, and a second run waits for the first", async () => {
  const t = setup([row("A", 100)]);
  const down = createPruettClient({ baseUrl: "https://pruett.test", key: KEY, level: "Builder", fetch: async () => { throw new Error("boom"); } });
  const run = (await runPriceSync({ catalog: t.catalog, runs: t.runs, getClient: () => down }, { trigger: "manual", log: () => undefined })) as SyncRun;
  assert.equal(run.status, "error");
  assert.match(run.error ?? "", /Could not reach/);

  const first = await t.runs.start("cron", null, new Date());
  assert.ok(first);
  assert.deepEqual(await runPriceSync({ catalog: t.catalog, runs: t.runs, getClient: () => down }, { trigger: "manual", log: () => undefined }), { status: "busy" });
});

test("a missing Pruett configuration is logged as an error run", async () => {
  const t = setup();
  const run = (await runPriceSync({ catalog: t.catalog, runs: t.runs, getClient: () => createPruettClient(pruettConfigFromEnv({})) }, { trigger: "manual", log: () => undefined })) as SyncRun;
  assert.equal(run.status, "error");
  assert.match(run.error ?? "", /PRUETT_FEED_URL/);
});

test("2 AM Central, in summer (CDT) and winter (CST)", () => {
  assert.equal(isSyncHourCentral(new Date("2026-07-15T07:00:00Z")), true);    // CDT = UTC-5
  assert.equal(isSyncHourCentral(new Date("2026-07-15T08:00:00Z")), false);
  assert.equal(isSyncHourCentral(new Date("2026-11-10T08:00:00Z")), true);    // CST = UTC-6
  assert.equal(isSyncHourCentral(new Date("2026-11-10T07:00:00Z")), false);
});

test("a price that moves more than 50% is held with a warning; exactly 50% is applied", async () => {
  const t = setup([row("A", 10_000), row("B", 10_000), row("C", 10_000)]);
  await t.sync();
  t.feed.items = [row("A", 15_000), row("B", 15_001), row("C", 10_000)];     // +50% exactly, +50.01%, unchanged
  const run = await t.sync();
  assert.equal(find(t.catalog, "A").retailCents, 15_000);
  assert.equal(find(t.catalog, "B").retailCents, 10_000);                    // held: untouched
  assert.equal(t.catalog.history.length, 1);
  assert.equal(run.status, "warning");
  assert.match(run.warning ?? "", /1 price\(s\) moved more than 50%.*B /);
});

test("dry run: shows the plan and writes nothing, not even a run record", async () => {
  const t = setup([row("A", 10_000)]);
  await t.sync();
  const before = t.runs.runs.length;
  t.feed.items = [row("A", 11_000), row("NEW", 500)];
  const client = createPruettClient({ baseUrl: "https://pruett.test", key: KEY, level: "Builder", fetch: async () => new Response(JSON.stringify({ level: "Builder", level_not_set: false, count: 2, items: t.feed.items })) });
  const plan = await previewPriceSync({ catalog: t.catalog, getClient: () => client });
  assert.deepEqual([plan.creates.length, plan.updates.length], [1, 1]);
  assert.equal(find(t.catalog, "A").retailCents, 10_000);
  assert.equal(t.catalog.products.length, 1);
  assert.equal(t.runs.runs.length, before);
});

test("503 (feed off at Pruett) and 404 (no such level) get clear errors; the older PRUETT_POS_API_* names still work", async () => {
  const t = setup([row("A", 100)]);
  t.feed.status = 503;
  assert.match((await t.sync()).error ?? "", /turned off/);
  t.feed.status = 404;
  assert.match((await t.sync()).error ?? "", /no price level named Builder/);
  const legacy = pruettConfigFromEnv({ PRUETT_POS_API_URL: "https://pruetthis.app/api", PRUETT_POS_API_KEY: "k" });
  assert.equal(legacy.baseUrl, "https://pruetthis.app");
  assert.equal(pruettConfigFromEnv({ PRUETT_FEED_URL: "https://new", PRUETT_FEED_KEY: "n", PRUETT_POS_API_URL: "https://old/api", PRUETT_POS_API_KEY: "o" }).baseUrl, "https://new");
});

test("a zero retail price in the feed is skipped, not added", async () => {
  const t = setup([row("A", 100), row("Z", 0, { price_cents: 0 })]);
  const run = await t.sync();
  assert.deepEqual(skus(t.catalog), ["A"]);
  assert.equal(run.status, "warning");
});
