// Baseline: for a database created before the runner existed (production). It does NOT run any SQL from the
// migration files. It looks at what the database already contains, and for each migration checks that the objects
// that migration creates are present. Migrations that are all present are recorded in schema_migrations as applied
// (baselined = true) so the runner never tries to run them again.
//
// Safety rules:
//  - Only a clean prefix is accepted: 001..N all present, N+1.. all absent. A gap (say 009 missing but 010 present)
//    means the database is in a state nobody expected, so nothing is written and the problem is reported.
//  - A migration that is only partly present is reported, never marked.
//  - Dry run unless apply is true.
import {
  MigrationError, ensureMigrationsTable, hasTable, readApplied, withLock,
  type Migration, type MigrationClient,
} from "./runner.ts";
import { SIGNATURES, type Signature } from "./signatures.ts";

export type ObjectCheck = { what: string; present: boolean };
export type MigrationState = { id: string; state: "present" | "absent" | "partial"; checks: ObjectCheck[] };

async function check(client: MigrationClient, sig: Signature): Promise<ObjectCheck[]> {
  const out: ObjectCheck[] = [];
  for (const t of sig.tables ?? []) {
    out.push({ what: `table ${t}`, present: await hasTable(client, t) });
  }
  for (const c of sig.columns ?? []) {
    const [table, column] = c.split(".");
    const r = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2", [table, column]);
    out.push({ what: `column ${c}`, present: r.rows.length > 0 });
  }
  for (const i of sig.indexes ?? []) {
    const r = await client.query("SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1", [i]);
    out.push({ what: `index ${i}`, present: r.rows.length > 0 });
  }
  for (const v of sig.views ?? []) {
    const r = await client.query("SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = $1", [v]);
    out.push({ what: `view ${v}`, present: r.rows.length > 0 });
  }
  return out;
}

export async function inspectDatabase(client: MigrationClient, all: Migration[]): Promise<MigrationState[]> {
  const states: MigrationState[] = [];
  for (const m of all) {
    const sig = SIGNATURES[m.id];
    if (!sig) throw new MigrationError(`No baseline signature for ${m.id}. Add one to src/lib/migrate/signatures.ts.`);
    const checks = await check(client, sig);
    const present = checks.filter((c) => c.present).length;
    states.push({ id: m.id, checks, state: present === checks.length ? "present" : present === 0 ? "absent" : "partial" });
  }
  return states;
}

export type BaselinePlan =
  | { ok: true; mark: string[]; states: MigrationState[] }
  | { ok: false; problem: string; states: MigrationState[] };

/** Pure: decide what may be marked from the inspected states. */
export function planBaseline(states: MigrationState[]): BaselinePlan {
  const partial = states.find((s) => s.state === "partial");
  if (partial) {
    const missing = partial.checks.filter((c) => !c.present).map((c) => c.what).join(", ");
    return { ok: false, states, problem: `${partial.id} is only partly in the database (missing: ${missing}). Nothing was marked. Ask the developer to look before going on.` };
  }
  const firstAbsent = states.findIndex((s) => s.state === "absent");
  const mark = (firstAbsent === -1 ? states : states.slice(0, firstAbsent)).map((s) => s.id);
  const gap = firstAbsent === -1 ? undefined : states.slice(firstAbsent).find((s) => s.state === "present");
  if (gap) {
    return { ok: false, states, problem: `${states[firstAbsent].id} is missing but ${gap.id} is present. That is not a state the migrations produce, so nothing was marked.` };
  }
  if (mark.length === 0) {
    return { ok: false, states, problem: "None of the migrations are in this database. This looks like an empty database; run db:migrate instead of the baseline." };
  }
  return { ok: true, mark, states };
}

export type BaselineResult = { plan: BaselinePlan; applied: boolean; alreadyMarked: string[] };

export async function baselineDatabase(
  client: MigrationClient, all: Migration[], opts: { apply: boolean },
): Promise<BaselineResult> {
  return withLock(client, async () => {
    if (!(await hasTable(client, "users"))) {
      throw new MigrationError("This database has no users table, so there is nothing to baseline. Run db:migrate to build it from scratch.");
    }
    const existing = (await readApplied(client)) ?? [];
    const alreadyMarked = existing.map((e) => e.id);
    const plan = planBaseline(await inspectDatabase(client, all));
    if (!plan.ok || !opts.apply) return { plan, applied: false, alreadyMarked };
    const todo = all.filter((m) => plan.mark.includes(m.id) && !alreadyMarked.includes(m.id));
    await client.query("BEGIN");
    try {
      await ensureMigrationsTable(client);
      for (const m of todo) {
        await client.query("INSERT INTO schema_migrations (id, checksum, baselined) VALUES ($1, $2, true)", [m.id, m.checksum]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    }
    return { plan, applied: true, alreadyMarked };
  });
}
