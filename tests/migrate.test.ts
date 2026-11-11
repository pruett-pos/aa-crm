import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MigrationError, checksumOf, loadMigrations, planMigrations, runMigrations, type Migration, type MigrationClient,
} from "../src/lib/migrate/runner.ts";
import { planBaseline, type MigrationState } from "../src/lib/migrate/baseline.ts";
import { SIGNATURES } from "../src/lib/migrate/signatures.ts";

const mig = (id: string, sql = `-- ${id}`): Migration => ({ id, sql, checksum: checksumOf(sql) });

/** A fake database that records what it was asked to do. Statements containing "FAIL" throw. */
function fakeDb(applied: { id: string; checksum: string }[] | null) {
  const log: string[] = [];
  const client: MigrationClient = {
    async query(text: string, params?: unknown[]) {
      const t = text.trim();
      log.push(params?.length ? `${t.split("\n")[0]} ${JSON.stringify(params)}` : t.split("\n")[0]);
      if (t.includes("to_regclass")) return { rows: [{ t: applied ? "schema_migrations" : null }] };
      if (t.startsWith("SELECT id, checksum")) return { rows: applied ?? [] };
      if (t.includes("FAIL")) throw new Error("boom");
      return { rows: [] };
    },
  };
  return { client, log };
}

function dirWith(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "mig-"));
  mkdirSync(join(root, "migrations"));
  writeFileSync(join(root, "schema.sql"), "-- schema");
  for (const [n, sql] of Object.entries(files)) writeFileSync(join(root, "migrations", n), sql);
  return root;
}

test("plan: only migrations not yet recorded are pending, in order", () => {
  const all = [mig("001_schema"), mig("002_a"), mig("003_b")];
  const plan = planMigrations(all, [{ id: "001_schema", checksum: all[0].checksum }, { id: "002_a", checksum: all[1].checksum }]);
  assert.deepEqual(plan.pending.map((m) => m.id), ["003_b"]);
  assert.deepEqual(plan.changed, []);
});

test("plan: an applied migration whose file changed is flagged; an unknown applied one is noted", () => {
  const all = [mig("001_schema"), mig("002_a")];
  const plan = planMigrations(all, [{ id: "001_schema", checksum: "different" }, { id: "009_future", checksum: "x" }]);
  assert.deepEqual(plan.changed, ["001_schema"]);
  assert.deepEqual(plan.unknown, ["009_future"]);
});

test("load: schema.sql is 001, files run in numeric order, and bad names are refused", () => {
  const ok = loadMigrations(dirWith({ "003_b.sql": "select 3", "002_a.sql": "select 2" }));
  assert.deepEqual(ok.map((m) => m.id), ["001_schema", "002_a", "003_b"]);
  assert.throws(() => loadMigrations(dirWith({ "2_a.sql": "x" })), /names must look like/);
  assert.throws(() => loadMigrations(dirWith({ "002_A.sql": "x" })), /names must look like/);
  assert.throws(() => loadMigrations(dirWith({ "002_a.sql": "x", "002_b.sql": "y" })), /already uses number 002/);
});

test("load: a file that opens its own transaction is refused (the runner owns the transaction)", () => {
  for (const sql of ["BEGIN;\nselect 1;\nCOMMIT;", "select 1;\n  commit;", "ROLLBACK;"]) {
    assert.throws(() => loadMigrations(dirWith({ "002_a.sql": sql })), /BEGIN\/COMMIT\/ROLLBACK/, sql);
  }
  // BEGIN inside a function body is fine
  assert.doesNotThrow(() => loadMigrations(dirWith({ "002_a.sql": "CREATE FUNCTION f() RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;" })));
});

test("run: each pending migration runs in its own transaction with its schema_migrations row, in order", async () => {
  const { client, log } = fakeDb([]);
  const res = await runMigrations(client, [mig("001_schema"), mig("002_a")]);
  assert.deepEqual(res.applied, ["001_schema", "002_a"]);
  const seq = log.filter((l) => /^(BEGIN|COMMIT|-- 00|INSERT INTO schema_migrations)/.test(l)).map((l) => l.replace(/ \[.*/, ""));
  assert.deepEqual(seq, ["BEGIN", "-- 001_schema", "INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", "COMMIT",
    "BEGIN", "-- 002_a", "INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", "COMMIT"]);
});

test("run: nothing pending means nothing is run", async () => {
  const a = mig("001_schema");
  const { client, log } = fakeDb([{ id: a.id, checksum: a.checksum }]);
  assert.deepEqual((await runMigrations(client, [a])).applied, []);
  assert.ok(!log.includes("BEGIN"));
});

test("run: a failing migration is rolled back and later ones do not run; earlier ones stay applied", async () => {
  const { client, log } = fakeDb([]);
  await assert.rejects(() => runMigrations(client, [mig("001_schema"), mig("002_bad", "FAIL"), mig("003_c")]), /002_bad failed and was rolled back: boom/);
  assert.ok(log.includes("ROLLBACK"));
  assert.ok(!log.some((l) => l.startsWith("-- 003_c")));
  assert.equal(log.filter((l) => l === "COMMIT").length, 1);   // only 001
  assert.ok(log.some((l) => l.includes("pg_advisory_unlock")), "lock released after a failure");
});

test("run: dry run lists pending and writes nothing (not even the schema_migrations table)", async () => {
  const { client, log } = fakeDb(null);
  const res = await runMigrations(client, [mig("001_schema"), mig("002_a")], { dryRun: true });
  assert.deepEqual(res, { applied: [], pending: ["001_schema", "002_a"], dryRun: true });
  assert.ok(!log.some((l) => /CREATE TABLE|BEGIN|INSERT/.test(l)));
});

test("run: refuses to go on when an applied migration file was edited", async () => {
  const { client } = fakeDb([{ id: "001_schema", checksum: "old" }]);
  await assert.rejects(() => runMigrations(client, [mig("001_schema"), mig("002_a")]), (e) => e instanceof MigrationError && /edited after they ran: 001_schema/.test(e.message));
});

const st = (id: string, state: MigrationState["state"]): MigrationState => ({ id, state, checks: [{ what: `table ${id}`, present: state === "present" }, ...(state === "partial" ? [{ what: "index x", present: false }] : [])] });

test("baseline plan: a clean prefix is marked; the rest is left to run", () => {
  const p = planBaseline([st("001_schema", "present"), st("002_a", "present"), st("003_b", "absent")]);
  assert.deepEqual(p.ok && p.mark, ["001_schema", "002_a"]);
});

test("baseline plan: everything present marks everything", () => {
  const p = planBaseline([st("001_schema", "present"), st("002_a", "present")]);
  assert.deepEqual(p.ok && p.mark, ["001_schema", "002_a"]);
});

test("baseline plan: a gap (absent then present) is refused", () => {
  const p = planBaseline([st("001_schema", "present"), st("002_a", "absent"), st("003_b", "present")]);
  assert.equal(p.ok, false);
  assert.match(!p.ok ? p.problem : "", /002_a is missing but 003_b is present/);
});

test("baseline plan: a partly-present migration is refused and says what is missing", () => {
  const p = planBaseline([st("001_schema", "present"), st("002_a", "partial")]);
  assert.equal(p.ok, false);
  assert.match(!p.ok ? p.problem : "", /002_a is only partly.*index x/);
});

test("baseline plan: an empty database is not baselined", () => {
  const p = planBaseline([st("001_schema", "absent"), st("002_a", "absent")]);
  assert.equal(p.ok, false);
});

test("every migration file in the repo has a baseline signature and a clean name", () => {
  const all = loadMigrations(new URL("../db", import.meta.url).pathname);
  for (const m of all) assert.ok(SIGNATURES[m.id], `no signature for ${m.id}`);
  assert.ok(all.length >= 16);
});
