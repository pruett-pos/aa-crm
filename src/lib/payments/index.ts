import type { PaymentStore } from "./types.ts";
import { createPrismaPaymentStore } from "./prisma-store.ts";
import { getDb } from "../db.ts";

const g = globalThis as unknown as { __aaPaymentStore?: PaymentStore };

export function getPaymentStore(): PaymentStore {
  return (g.__aaPaymentStore ??= createPrismaPaymentStore(getDb()));
}
