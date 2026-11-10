// Nightly Pruett price sync: refreshes the retail price of catalog products from Pruett POS's Builder price feed.
// Meant to run as a Railway cron service (nightly) and by hand.
//
// DRY RUN by default: it only lists what would change. Nothing is saved until you add --apply.
// It only changes prices of products already in the catalog (matched by SKU); it never adds or removes products.
// Price moves over 50% are listed as "held" and not applied.
//
//   node --env-file=.env --experimental-strip-types scripts/pruett-sync.ts           (dry run)
//   node --env-file=.env --experimental-strip-types scripts/pruett-sync.ts --apply   (do it)
//
import { getDb } from "../src/lib/db.ts";
import { getCatalogStore } from "../src/lib/catalog/index.ts";
import { PruettError, fetchPruettPrices, pruettConfigFromEnv } from "../src/integrations/pruett/client.ts";
import { applyPriceSync, feedProblem, planPriceSync, type PriceChange } from "../src/lib/catalog/sync.ts";

const apply = process.argv.includes("--apply");
const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
const line = (c: PriceChange) => `  ${c.sku} (${c.name}): ${dollars(c.fromCents)} -> ${dollars(c.toCents)}`;

const cfg = pruettConfigFromEnv();
if (!cfg) {
  console.log("Pruett POS is not connected: PRUETT_POS_API_URL / PRUETT_POS_API_KEY are not set. Nothing to do.");
  process.exit(0);
}

let code = 0;
try {
  const feed = await fetchPruettPrices(cfg, "Builder");
  const problem = feedProblem(feed);
  if (problem) {
    console.error(problem === "empty_feed"
      ? "Pruett sent no products. Nothing was changed."
      : "Pruett's Builder price level has no percentage set, so nothing was changed. Set it in Pruett POS, then run again.");
    code = 1;
  } else {
    const store = getCatalogStore();
    const plan = planPriceSync(await store.list(), feed);
    console.log(`Pruett feed ${feed.generatedAt}: ${feed.items.length} items. Catalog: ${plan.changes.length} to change, ${plan.held.length} held, ${plan.unchanged} unchanged, ${plan.notInFeed.length} not in Pruett's feed.`);
    plan.changes.forEach((c) => console.log(line(c)));
    if (plan.held.length) { console.log("Held (moved over 50%, check in Pruett POS first):"); plan.held.forEach((c) => console.log(line(c))); }
    if (plan.notInFeed.length) console.log(`Not in Pruett's feed (kept as is): ${plan.notInFeed.join(", ")}`);
    if (apply) console.log(`Saved ${await applyPriceSync(store, plan)} price(s).`);
    else if (plan.changes.length) console.log("Dry run: add --apply to save.");
  }
} catch (e) {
  console.error(e instanceof PruettError ? `Pruett sync failed (${e.kind}): ${e.message}` : e);
  code = 1;
}
await getDb().$disconnect();
process.exit(code);
