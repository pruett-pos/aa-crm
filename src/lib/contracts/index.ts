import type { ContractStore } from "./types.ts";
import { createPrismaContractStore } from "./prisma-store.ts";
import { getDb } from "../db.ts";

const g = globalThis as unknown as { __aaContractStore?: ContractStore };

export function getContractStore(): ContractStore {
  return (g.__aaContractStore ??= createPrismaContractStore(getDb()));
}
