import { test } from "node:test";
import assert from "node:assert/strict";
import { setupDatabase, type SetupClient } from "../src/lib/setup-db.ts";

function fakeClient(usersExists: boolean, failOnSetup = false) {
  const log: string[] = [];
  const client: SetupClient = {
    async query(text: string) {
      log.push(text);
      if (text.includes("to_regclass")) return { rows: [{ users: usersExists ? "users" : null }] };
      if (failOnSetup && text.startsWith("-- SETUP")) throw new Error("boom");
      return { rows: [] };
    },
  };
  return { client, log };
}

test("creates the schema on an empty database", async () => {
  const { client, log } = fakeClient(false);
  assert.equal(await setupDatabase(client, "-- SETUP"), "created");
  assert.ok(log.includes("-- SETUP"));
});

test("does nothing when the users table already exists", async () => {
  const { client, log } = fakeClient(true);
  assert.equal(await setupDatabase(client, "-- SETUP"), "already_set_up");
  assert.ok(!log.includes("-- SETUP"));
});

test("releases the lock even when setup fails", async () => {
  const { client, log } = fakeClient(false, true);
  await assert.rejects(() => setupDatabase(client, "-- SETUP"), /boom/);
  assert.ok(log.some((q) => q.includes("pg_advisory_unlock")));
});
