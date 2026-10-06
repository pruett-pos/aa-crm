import { getDb } from "../db.ts";
import { createPrismaMeasurementStore } from "./prisma-store.ts";
import type { MeasurementStore } from "./types.ts";

const g = globalThis as unknown as { __aaMeasurementStore?: MeasurementStore };

export function getMeasurementStore(): MeasurementStore {
  return (g.__aaMeasurementStore ??= createPrismaMeasurementStore(getDb()));
}
