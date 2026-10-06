import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { Tier } from "../scopes/types.ts";
import { LABOR_ROLES, MATERIAL_ROLES } from "./roofing.ts";
import type { AssemblyLine } from "./assemblies.ts";
import type { AssemblyEdit, AssemblyStore } from "./service.ts";

const UUID = /^[0-9a-f-]{36}$/i;

export function createPrismaAssemblyStore(db: PrismaClient): AssemblyStore {
  return {
    async list(): Promise<AssemblyLine[]> {
      const rows = await db.roofingAssemblyLine.findMany({ orderBy: [{ sortOrder: "asc" }, { role: "asc" }] });
      return rows.map((r) => ({
        tier: r.tier as Tier, role: r.role, kind: r.kind === "labor" ? "labor" : "material", productId: r.productId, description: r.description, unit: r.unit,
        coverage: r.coverage === null ? null : Number(r.coverage.toString()), unitCostCents: r.unitCostCents === null ? null : Number(r.unitCostCents),
        sortOrder: r.sortOrder, enabled: r.enabled,
      }));
    },

    async upsert(e: AssemblyEdit & { kind: "material" | "labor" }, userId: string) {
      const order = [...MATERIAL_ROLES, ...LABOR_ROLES].indexOf(e.role as never);
      const data = {
        kind: e.kind, productId: e.productId && UUID.test(e.productId) ? e.productId : null, description: e.description, unit: e.unit,
        coverage: e.coverage, unitCostCents: e.unitCostCents === null ? null : BigInt(e.unitCostCents), enabled: e.enabled, updatedBy: userId,
      };
      await db.roofingAssemblyLine.upsert({
        where: { tier_role: { tier: e.tier, role: e.role } },
        create: { tier: e.tier, role: e.role, sortOrder: e.sortOrder ?? (order < 0 ? 0 : order + 1) * 10, ...data },
        update: { ...data, ...(e.sortOrder === undefined ? {} : { sortOrder: e.sortOrder }) },
      });
    },
  };
}
