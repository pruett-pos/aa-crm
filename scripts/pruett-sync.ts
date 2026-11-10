// Nightly Pruett price sync. Runs as its own Railway cron service (see the PR / docs/SPEC.md) and by hand:
//
//   npm run pruett:sync                 (only runs when it is 2 AM in Central time; otherwise exits quietly)
//   npm run pruett:sync -- --now        (run now, whatever the time)
//   npm run pruett:sync -- --dry-run    (show what would change; writes nothing, logs no run; any time of day)
//
// Railway cron is UTC with no time zone, so the service is scheduled for both 07:00 and 08:00 UTC ("0 7,8 * * *") and
// this script lets through only the run that falls on 2 AM Central (CDT or CST). Needs DATABASE_URL, PRUETT_FEED_URL and
// PRUETT_FEED_KEY; PRUETT_PRICE_LEVEL defaults to Builder. Exits 1 when the sync fails so Railway shows the run as failed.
import { getDb } from "../src/lib/db.ts";
import { previewPruettSync, runPruettSync } from "../src/lib/catalog/index.ts";
import { isSyncHourCentral } from "../src/lib/catalog/price-sync.ts";

if (process.argv.includes("--dry-run")) {
  try {
    const p = await previewPruettSync();
    console.log(`dry run: ${p.seen} items in the feed; would add ${p.creates.length}, change ${p.updates.length}, deactivate ${p.deactivateIds.length}, hold ${p.held.length}`);
    for (const u of p.updates.filter((x) => x.price).slice(0, 50)) console.log(`  ${u.id}: retail ${u.price!.oldRetailCents} -> ${u.price!.newRetailCents}, cost ${u.price!.oldCostCents} -> ${u.price!.newCostCents} (cents)`);
    for (const h of p.held) console.log(`  HELD ${h.sku}: retail ${h.from} -> ${h.to} (cents)`);
    for (const w of p.warnings) console.log(`  WARNING: ${w}`);
    await getDb().$disconnect().catch(() => undefined);
    process.exit(0);
  } catch (e) {
    console.error("dry run failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

if (!process.argv.includes("--now") && !isSyncHourCentral(new Date())) {
  console.log("pruett sync: not 2 AM Central; nothing to do (use --now to run anyway)");
  process.exit(0);
}

let code = 0;
try {
  const run = await runPruettSync({ trigger: "cron" });
  if (run.status === "error") code = 1;           // "busy" (another run in progress) and ok/warning exit 0
} catch (e) {
  console.error("pruett sync: could not run", e instanceof Error ? e.message : e);
  code = 1;
} finally {
  await getDb().$disconnect().catch(() => undefined);
}
process.exit(code);
