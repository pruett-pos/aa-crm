import { getDb } from "../db.ts";
import { createPrismaWorkOrderStore } from "./prisma-store.ts";
import type { WorkOrderStore } from "./types.ts";

const g = globalThis as unknown as { __aaWorkOrderStore?: WorkOrderStore };

export function getWorkOrderStore(): WorkOrderStore {
  return (g.__aaWorkOrderStore ??= createPrismaWorkOrderStore(getDb()));
}
