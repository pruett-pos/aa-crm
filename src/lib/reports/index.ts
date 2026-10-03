import type { ReportStore } from "./types.ts";
import { createPrismaReportStore } from "./prisma-store.ts";
import { getDb } from "../db.ts";

const g = globalThis as unknown as { __aaReportStore?: ReportStore };

export function getReportStore(): ReportStore {
  return (g.__aaReportStore ??= createPrismaReportStore(getDb()));
}
