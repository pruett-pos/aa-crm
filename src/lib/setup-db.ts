// One-time database setup, run as Railway's pre-deploy step (see railway.json).
// Safe to run on every deploy: it does nothing once the users table exists.

export type SetupClient = {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export type SetupResult = "created" | "already_set_up";

const LOCK_KEY = 7421001; // arbitrary constant: two deploys starting together cannot both create tables

export async function setupDatabase(client: SetupClient, setupSql: string): Promise<SetupResult> {
  await client.query(`SELECT pg_advisory_lock(${LOCK_KEY})`);
  try {
    const found = await client.query("SELECT to_regclass('users') AS users");
    if (found.rows[0]?.users) return "already_set_up";
    await client.query(setupSql); // the file wraps itself in BEGIN ... COMMIT
    return "created";
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`).catch(() => undefined);
  }
}
