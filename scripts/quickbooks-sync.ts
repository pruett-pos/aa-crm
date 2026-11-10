// Cron tool: push whatever is waiting to QuickBooks (invoices, payments, voids) and retry what failed earlier.
// Run it every few minutes as a Railway cron service. Also keeps the QuickBooks sign-in alive (the refresh token is
// renewed whenever the access token has expired, so a regular run means nobody has to reconnect).
//
//   node --env-file=.env --experimental-strip-types scripts/quickbooks-sync.ts
//   node --env-file=.env --experimental-strip-types scripts/quickbooks-sync.ts --dry-run     (only list what is waiting)
//   node --env-file=.env --experimental-strip-types scripts/quickbooks-sync.ts --limit 100
//
import { getDb } from "../src/lib/db.ts";
import { getQboConfig, getQboStore, getQboTokenStore, syncNow } from "../src/lib/quickbooks/index.ts";
import { createQboTokenProvider } from "../src/lib/quickbooks/tokens.ts";

const dry = process.argv.includes("--dry-run");
const li = process.argv.indexOf("--limit");
const limit = li >= 0 ? Math.max(1, Math.min(500, Number(process.argv[li + 1]) || 25)) : 25;

const config = getQboConfig();
if (!config) {
  console.log("QuickBooks is not set up: QBO_CLIENT_ID, QBO_CLIENT_SECRET and QBO_REDIRECT_URI are not all set. Nothing to do.");
  process.exit(0);
}
const tokens = getQboTokenStore();
if (!(await tokens.get())) {
  console.log("QuickBooks is not connected (Settings, QuickBooks, Connect). Nothing to do.");
  await getDb().$disconnect();
  process.exit(0);
}

let code = 0;
try {
  if (dry) {
    const store = getQboStore();
    const c = await store.counts();
    console.log(`Waiting ${c.pending + c.waiting}, failed ${c.failed}, done ${c.done}, mismatches ${c.mismatch} (dry run: nothing sent)`);
  } else {
    // Keep the sign-in fresh even when there is nothing to send.
    await createQboTokenProvider({ store: tokens, config, fetch: (u, i) => fetch(u, i) })(false);
    const r = await syncNow(limit);
    console.log(JSON.stringify(r));
    if (r?.stoppedForAuth) { console.log("Stopping: QuickBooks refused the saved access. An admin needs to connect it again."); code = 1; }
  }
} catch (e) {
  console.error(`quickbooks sync failed: ${e instanceof Error ? `${e.name}: ${e.message}` : "unknown"}`);
  code = 1;
}
await getDb().$disconnect();
process.exit(code);
