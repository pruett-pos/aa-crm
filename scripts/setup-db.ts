// Creates the schema on an empty database, once. Run by Railway before each deploy:
//   node --experimental-strip-types scripts/setup-db.ts
// Does nothing when the users table already exists. Never touches existing data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { setupDatabase } from "../src/lib/setup-db.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

// Railway's private address needs no TLS; the public proxy address does.
const ssl = new URL(url).hostname.endsWith(".railway.internal") ? undefined : { rejectUnauthorized: false };
const sql = readFileSync(fileURLToPath(new URL("../db/setup-production.sql", import.meta.url)), "utf8");

const client = new pg.Client({ connectionString: url, ssl });
await client.connect();
try {
  const result = await setupDatabase(client, sql);
  console.log(result === "created" ? "Database schema created." : "Database already set up; nothing to do.");
} catch (e) {
  console.error("Database setup failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await client.end();
}
