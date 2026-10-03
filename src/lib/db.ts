import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";

// One client (and connection pool) per server process, shared by all stores.
const g = globalThis as unknown as { __aaDb?: PrismaClient };

export function getDb(): PrismaClient {
  if (g.__aaDb) return g.__aaDb;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  g.__aaDb = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return g.__aaDb;
}
