// Runs the migration runner, the baseline, the audit trigger and the rate limiter against a REAL Postgres.
// Needs TEST_DATABASE_URL (a superuser or a role that can create databases), for example
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres npm test
// CI sets it (Postgres 16 service). Without it these tests are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { baselineDatabase } from "../src/lib/migrate/baseline.ts";
import { checksumOf, loadMigrations, readApplied, runMigrations, type Migration } from "../src/lib/migrate/runner.ts";
import { SIGNATURES } from "../src/lib/migrate/signatures.ts";
import { allowPersistent, createSqlRateLimitStore } from "../src/lib/auth/rate-limit-db.ts";

const adminUrl = process.env.TEST_DATABASE_URL;
const skip = adminUrl ? false : "TEST_DATABASE_URL is not set";
const all = loadMigrations(new URL("../db", import.meta.url).pathname);

async function withDb(fn: (c: pg.Client, url: string) => Promise<void>) {
  const name = `aacrm_test_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(adminUrl!);
  u.pathname = `/${name}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    await fn(c, u.toString());
  } finally {
    await c.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}

/** What production looked like before the runner: schema + migrations up to `upTo`, applied directly, nothing recorded. */
async function buildLegacy(c: pg.Client, upTo: string) {
  for (const m of all) {
    await c.query(m.sql);
    if (m.id === upTo) break;
  }
}

test("fresh database: runs everything once, a second run does nothing", { skip }, async () => {
  await withDb(async (c) => {
    const first = await runMigrations(c, all);
    assert.deepEqual(first.applied, all.map((m) => m.id));
    assert.deepEqual((await readApplied(c))!.map((a) => a.id), all.map((m) => m.id));
    assert.deepEqual((await runMigrations(c, all)).applied, []);
    const users = await c.query("SELECT to_regclass('users') AS t");
    assert.ok(users.rows[0].t);
  });
});

test("dry run on an empty database lists everything and creates nothing", { skip }, async () => {
  await withDb(async (c) => {
    const r = await runMigrations(c, all, { dryRun: true });
    assert.equal(r.pending.length, all.length);
    assert.equal((await c.query("SELECT to_regclass('schema_migrations') AS t")).rows[0].t, null);
    assert.equal((await c.query("SELECT to_regclass('users') AS t")).rows[0].t, null);
  });
});

test("a failing migration rolls back completely (no half-applied table, no row)", { skip }, async () => {
  await withDb(async (c) => {
    await runMigrations(c, all);
    const bad = (id: string, sql: string): Migration => ({ id, sql, checksum: checksumOf(sql) });
    const extra = bad("099_bad", "CREATE TABLE half_done (id int); SELECT 1/0;");
    await assert.rejects(() => runMigrations(c, [...all, extra]), /099_bad failed and was rolled back/);
    assert.equal((await c.query("SELECT to_regclass('half_done') AS t")).rows[0].t, null);
    assert.ok(!(await readApplied(c))!.some((a) => a.id === "099_bad"));
    // and the failure did not leave the migration lock behind
    assert.deepEqual((await runMigrations(c, all)).applied, []);
  });
});

test("every baseline signature is true on a fully migrated database", { skip }, async () => {
  await withDb(async (c) => {
    await runMigrations(c, all);
    const r = await baselineDatabase(c, all, { apply: false });
    assert.ok(r.plan.states.every((s) => s.state === "present"), JSON.stringify(r.plan.states.filter((s) => s.state !== "present")));
    assert.ok(Object.keys(SIGNATURES).length >= all.length);
  });
});

test("baseline: a database that predates the runner is marked without running SQL, then only newer migrations run", { skip }, async () => {
  await withDb(async (c) => {
    await buildLegacy(c, "014_work_orders");
    await c.query("INSERT INTO users (full_name, email, role) VALUES ('AL', 'al@example.com', 'admin')");
    const dry = await baselineDatabase(c, all, { apply: false });
    assert.equal(dry.applied, false);
    assert.equal((await c.query("SELECT to_regclass('schema_migrations') AS t")).rows[0].t, null, "dry run writes nothing");

    const done = await baselineDatabase(c, all, { apply: true });
    assert.equal(done.applied, true);
    const marked = (await c.query("SELECT id, baselined FROM schema_migrations ORDER BY id")).rows;
    assert.equal(marked.length, 14);
    assert.ok(marked.every((r) => r.baselined === true));
    assert.equal((await c.query("SELECT to_regclass('audit_log') AS t")).rows[0].t, null, "baseline ran no migration SQL");

    const run = await runMigrations(c, all);
    assert.deepEqual(run.applied, ["015_audit_log", "016_rate_limits", "017_pruett_sync"]);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 1, "data untouched");
  });
});

test("baseline: refuses a database with a gap or a missing piece, and writes nothing", { skip }, async () => {
  await withDb(async (c) => {
    await buildLegacy(c, "014_work_orders");
    await c.query("DROP INDEX one_selected_scope_per_division");
    const r = await baselineDatabase(c, all, { apply: true });
    assert.equal(r.plan.ok, false);
    assert.equal(r.applied, false);
    assert.equal((await c.query("SELECT to_regclass('schema_migrations') AS t")).rows[0].t, null);
  });
});

test("baseline: refuses an empty database", { skip }, async () => {
  await withDb(async (c) => {
    await assert.rejects(() => baselineDatabase(c, all, { apply: true }), /no users table/);
  });
});

test("audit_log is append-only: update and delete are refused", { skip }, async () => {
  await withDb(async (c) => {
    await runMigrations(c, all);
    await c.query("INSERT INTO audit_log (action, entity_type, summary) VALUES ('user.created', 'user', 'x')");
    await assert.rejects(() => c.query("UPDATE audit_log SET summary = 'y'"), /append-only/);
    await assert.rejects(() => c.query("DELETE FROM audit_log"), /append-only/);
  });
});

test("rate limiter in Postgres: counts persist across store instances (a deploy), a new window resets", { skip }, async () => {
  await withDb(async (c) => {
    await runMigrations(c, all);
    const query = async (text: string, params: unknown[]) => (await c.query(text, params as unknown[])).rows;
    const t0 = new Date("2026-11-10T12:00:00Z");
    const a = createSqlRateLimitStore(query);
    for (let i = 0; i < 5; i++) assert.equal(await allowPersistent(a, "login:email:x@y.com", 5, 60_000, t0), true);
    // "deploy": a brand new store object over the same database still remembers
    const b = createSqlRateLimitStore(query);
    assert.equal(await allowPersistent(b, "login:email:x@y.com", 5, 60_000, new Date(t0.getTime() + 1000)), false);
    assert.equal(await allowPersistent(b, "login:email:other@y.com", 5, 60_000, t0), true, "another key is separate");
    // after the window the count restarts
    assert.equal(await allowPersistent(b, "login:email:x@y.com", 5, 60_000, new Date(t0.getTime() + 61_000)), true);
    // no address in clear in the table
    const keys = (await c.query("SELECT key FROM rate_limits")).rows.map((r) => r.key as string);
    assert.ok(keys.every((k) => /^[0-9a-f]{64}$/.test(k)));
  });
});

test("rate limiter in Postgres: concurrent hits are all counted", { skip }, async () => {
  await withDb(async (c, url) => {
    await runMigrations(c, all);
    const pool = new pg.Pool({ connectionString: url });
    try {
      const store = createSqlRateLimitStore(async (text, params) => (await pool.query(text, params as unknown[])).rows);
      const now = new Date();
      const counts = await Promise.all(Array.from({ length: 10 }, () => store.hit("k".repeat(64), 60_000, now)));
      assert.deepEqual([...counts].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      await pool.end();
    }
  });
});
