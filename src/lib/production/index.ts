import type { ProductionStore } from "./types.ts";
import { createPrismaProductionStore } from "./prisma-store.ts";
import { getDb } from "../db.ts";

const g = globalThis as unknown as { __aaProductionStore?: ProductionStore };

export function getProductionStore(): ProductionStore {
  return (g.__aaProductionStore ??= createPrismaProductionStore(getDb()));
}
