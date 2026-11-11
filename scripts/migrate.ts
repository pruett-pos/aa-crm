// Database migrations. See docs/OPERATIONS.md.
//
//   npm run db:migrate                 apply pending migrations (db/schema.sql on an empty database, then db/migrations/*.sql)
//   npm run db:migrate -- --dry-run    list pending migrations; changes nothing
//   npm run db:baseline                (once, on a database that predates the runner) show what would be marked as applied
//   npm run db:baseline -- --apply     mark those migrations as applied (runs none of their SQL)
//   node scripts/migrate.ts --on-start the deploy step run by `npm start` (see below)
//
// --on-start never blocks a deploy because of an un-baselined database: it warns and lets the app start.
// It DOES stop the deploy when a pending migration fails (that migration is rolled back first).
// MIGRATE_AUTO_BASELINE=true (set for ONE deploy) lets --on-start do the baseline step itself.
import { fileURLToPath } from "node:url";
import pg from "pg";
import { connectionSettings } from "../src/lib/migrate/connect.ts";
import { baselineDatabase } from "../src/lib/migrate/baseline.ts";
import { MigrationError, hasTable, isUnbaselined, loadMigrations, readApplied, planMigrations, runMigrations } from "../src/lib/migrate/runner.ts";
import { logError } from "../src/lib/ops/log.ts";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const all = loadMigrations(fileURLToPath(new URL("../db", import.meta.url)));
const client = new pg.Client(connectionSettings(url));
const log = (line: string) => console.log(line);
await client.connect();

async function seedFirstAdmin() {
  const email = process.env.FIRST_ADMIN_EMAIL?.trim().toLowerCase();
  const exists = await client.query("SELECT 1 FROM users WHERE role = 'admin' AND active LIMIT 1");
  if (exists.rows.length) return;
  if (!email) {
    log("Warning: there is no active admin and FIRST_ADMIN_EMAIL is not set, so nobody can sign in. Set FIRST_ADMIN_EMAIL (and FIRST_ADMIN_NAME) and deploy again.");
    return;
  }
  await client.query(
    "INSERT INTO users (full_name, email, role) VALUES ($1, $2, 'admin') ON CONFLICT (email) DO UPDATE SET role = 'admin', active = true",
    [process.env.FIRST_ADMIN_NAME?.trim() || "Admin", email]);
  log(`Created the first admin: ${email}`);
}

async function main() {
  if (flag("--baseline")) {
    const apply = flag("--apply");
    const r = await baselineDatabase(client, all, { apply });
    for (const s of r.plan.states) log(`  ${s.state.padEnd(8)} ${s.id}${s.state === "partial" ? `  (missing: ${s.checks.filter((c) => !c.present).map((c) => c.what).join(", ")})` : ""}`);
    if (!r.plan.ok) {
      console.error(`\nNot baselined: ${r.plan.problem}`);
      process.exitCode = 1;
      return;
    }
    if (!apply) {
      log(`\nDry run. Would mark as already applied: ${r.plan.mark.join(", ")}`);
      log("Nothing was changed. Run again with --apply to record them.");
    } else {
      log(`\nMarked as applied: ${r.plan.mark.join(", ")}. No migration SQL was run.`);
      log("Next: npm run db:migrate -- --dry-run   (shows anything still pending)");
    }
    return;
  }

  const dryRun = flag("--dry-run");
  const onStart = flag("--on-start");

  if (await isUnbaselined(client)) {
    if (onStart && process.env.MIGRATE_AUTO_BASELINE === "true") {
      log("MIGRATE_AUTO_BASELINE=true: baselining first.");
      const r = await baselineDatabase(client, all, { apply: true });
      if (!r.plan.ok) throw new MigrationError(`Baseline refused: ${r.plan.problem}`);
      log(`Marked as applied: ${r.plan.mark.join(", ")}`);
    } else if (onStart) {
      console.warn("WARNING: this database predates the migration runner and has not been baselined, so no migrations were run. " +
        "Features added since then may fail until someone runs `npm run db:baseline -- --apply` (see docs/OPERATIONS.md). Starting anyway.");
      return;
    } else {
      throw new MigrationError("This database predates the migration runner. Run `npm run db:baseline` first (it is a dry run until you add --apply).");
    }
  }

  const empty = !(await hasTable(client, "users")) && !(await hasTable(client, "schema_migrations"));
  const result = await runMigrations(client, all, { dryRun, log });
  if (dryRun) {
    const applied = (await readApplied(client)) ?? [];
    const plan = planMigrations(all, applied);
    log(plan.pending.length ? `${plan.pending.length} pending migration(s):\n${plan.pending.map((m) => `  ${m.id}`).join("\n")}` : "No pending migrations.");
    if (empty) log("(This database is empty: all of the above would build it from scratch.)");
    return;
  }
  log(result.applied.length ? `Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}` : "Database is up to date.");
  if (empty || onStart) await seedFirstAdmin();
}

try {
  await main();
} catch (e) {
  logError("migrate.failed", e);
  console.error(e instanceof MigrationError ? e.message : e);
  process.exitCode = 1;
} finally {
  await client.end();
}
