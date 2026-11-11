// Migration runner. Applies SQL files exactly once, in order, each inside its own transaction, and records them in
// schema_migrations. Everything here talks to the database through a tiny client interface so it can be tested
// without a server (and against a real Postgres in CI).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MigrationClient = {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export type Migration = { id: string; sql: string; checksum: string };
export type AppliedMigration = { id: string; checksum: string };

/** The reference schema (db/schema.sql) is migration 001: it is what an empty database starts from. */
export const BASELINE_ID = "001_schema";
const FILE_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 7421002; // arbitrary constant: two deploys starting together cannot both migrate
// The runner opens the transaction, so a file must not do it too (that would commit or break ours).
const TX_STATEMENT = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im;

export class MigrationError extends Error {}

export const checksumOf = (sql: string) => createHash("sha256").update(sql).digest("hex");

function assertNoTransactionControl(id: string, sql: string) {
  if (TX_STATEMENT.test(sql)) {
    throw new MigrationError(`${id} contains BEGIN/COMMIT/ROLLBACK. The runner wraps every migration in a transaction; remove it from the file.`);
  }
}

/** Reads db/schema.sql (as 001) and db/migrations/NNN_name.sql in numeric order. */
export function loadMigrations(dbDir: string): Migration[] {
  const files = readdirSync(join(dbDir, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const out: Migration[] = [];
  const schema = readFileSync(join(dbDir, "schema.sql"), "utf8");
  assertNoTransactionControl(BASELINE_ID, schema);
  out.push({ id: BASELINE_ID, sql: schema, checksum: checksumOf(schema) });
  const seen = new Set<string>(["001"]);
  for (const f of files) {
    const m = FILE_NAME.exec(f);
    if (!m) throw new MigrationError(`db/migrations/${f}: names must look like 015_short_name.sql (three digits, lowercase)`);
    if (seen.has(m[1])) throw new MigrationError(`db/migrations/${f}: another migration already uses number ${m[1]}`);
    seen.add(m[1]);
    const sql = readFileSync(join(dbDir, "migrations", f), "utf8");
    const id = f.replace(/\.sql$/, "");
    assertNoTransactionControl(id, sql);
    out.push({ id, sql, checksum: checksumOf(sql) });
  }
  return out;
}

export type Plan = {
  pending: Migration[];
  /** Applied migrations whose file has changed since they ran. Editing an applied migration is always a mistake. */
  changed: string[];
  /** Recorded in the database but missing from the repo (a deploy of older code against a newer database). */
  unknown: string[];
};

export function planMigrations(all: Migration[], applied: AppliedMigration[]): Plan {
  const done = new Map(applied.map((a) => [a.id, a.checksum]));
  const known = new Set(all.map((m) => m.id));
  return {
    pending: all.filter((m) => !done.has(m.id)),
    changed: all.filter((m) => done.has(m.id) && done.get(m.id) !== m.checksum).map((m) => m.id),
    unknown: applied.filter((a) => !known.has(a.id)).map((a) => a.id),
  };
}

export async function hasTable(client: MigrationClient, name: string): Promise<boolean> {
  const r = await client.query("SELECT to_regclass($1) AS t", [`public.${name}`]);
  return r.rows[0]?.t != null;
}

export async function ensureMigrationsTable(client: MigrationClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    baselined  boolean NOT NULL DEFAULT false   -- true: marked as applied without running (it already existed)
  )`);
}

export async function readApplied(client: MigrationClient): Promise<AppliedMigration[] | null> {
  if (!(await hasTable(client, "schema_migrations"))) return null;
  const r = await client.query("SELECT id, checksum FROM schema_migrations ORDER BY id");
  return r.rows.map((x) => ({ id: String(x.id), checksum: String(x.checksum) }));
}

/** Runs `fn` while holding the migration lock (a session-level advisory lock). */
export async function withLock<T>(client: MigrationClient, fn: () => Promise<T>): Promise<T> {
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
  }
}

export type RunResult = { applied: string[]; pending: string[]; dryRun: boolean };

/**
 * Applies every pending migration, oldest first, each in its own transaction together with its schema_migrations row.
 * A failure rolls that migration back and stops; earlier ones stay applied. With dryRun nothing is written, not even
 * the schema_migrations table, and the pending list is returned.
 */
export async function runMigrations(
  client: MigrationClient, all: Migration[], opts: { dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<RunResult> {
  const log = opts.log ?? (() => undefined);
  return withLock(client, async () => {
    const applied = (await readApplied(client)) ?? [];
    const plan = planMigrations(all, applied);
    if (plan.changed.length) {
      throw new MigrationError(`These migrations were edited after they ran: ${plan.changed.join(", ")}. Put the change in a new migration instead.`);
    }
    if (plan.unknown.length) {
      log(`Note: the database has migrations this code does not know about (${plan.unknown.join(", ")}). Is this an older deploy?`);
    }
    const pending = plan.pending.map((m) => m.id);
    if (opts.dryRun) return { applied: [], pending, dryRun: true };

    await ensureMigrationsTable(client);
    const done: string[] = [];
    for (const m of plan.pending) {
      log(`Applying ${m.id} ...`);
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [m.id, m.checksum]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new MigrationError(`${m.id} failed and was rolled back: ${e instanceof Error ? e.message : String(e)}`);
      }
      done.push(m.id);
    }
    return { applied: done, pending: [], dryRun: false };
  });
}

/** True when this looks like a database that was set up before the runner existed (it has tables but no schema_migrations). */
export async function isUnbaselined(client: MigrationClient): Promise<boolean> {
  return !(await hasTable(client, "schema_migrations")) && (await hasTable(client, "users"));
}
