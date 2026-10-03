import type { CommissionStore } from "./types.ts";
import { createPrismaCommissionStore } from "./prisma-store.ts";
import { getDb } from "../db.ts";

const g = globalThis as unknown as { __aaCommissionStore?: CommissionStore };

export function getCommissionStore(): CommissionStore {
  return (g.__aaCommissionStore ??= createPrismaCommissionStore(getDb()));
}
