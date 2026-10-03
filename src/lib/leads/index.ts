import type { LeadStore } from "./types.ts";
import { createPrismaLeadStore } from "./prisma-store.ts";
import { getDb } from "../db.ts";

const g = globalThis as unknown as { __aaLeadStore?: LeadStore };

export function getLeadStore(): LeadStore {
  return (g.__aaLeadStore ??= createPrismaLeadStore(getDb()));
}
