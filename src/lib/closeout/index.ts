import { getDb } from "../db.ts";
import { createPrismaCloseoutStore } from "./prisma-store.ts";
import type { CloseoutStore } from "./types.ts";

const g = globalThis as unknown as { __aaCloseoutStore?: CloseoutStore };

export function getCloseoutStore(): CloseoutStore {
  return (g.__aaCloseoutStore ??= createPrismaCloseoutStore(getDb()));
}
