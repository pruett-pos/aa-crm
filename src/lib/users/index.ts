import { getDb } from "../db.ts";
import { createPrismaUserAdminStore } from "./prisma-store.ts";
import type { UserAdminStore } from "./types.ts";

const g = globalThis as unknown as { __aaUserAdminStore?: UserAdminStore };

export function getUserAdminStore(): UserAdminStore {
  return (g.__aaUserAdminStore ??= createPrismaUserAdminStore(getDb()));
}
