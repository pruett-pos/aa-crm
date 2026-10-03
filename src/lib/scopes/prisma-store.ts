import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { Division, Stage } from "../rules.ts";
import type {
  ComputedScope, JobAccess, JobSummary, LineKind, Product, ScopeStore, StoredScope, Tier,
} from "./types.ts";

type DbItem = {
  kind: string; sortOrder: number; productId: string | null; description: string;
  quantity: { toString(): string }; unitCostCents: bigint; unitPriceCents: bigint; color: string | null;
};
type DbScope = {
  id: string; tier: string; title: string; saleCents: bigint; costCents: bigint;
  targetMarginBps: number; items: DbItem[];
};

function toStored(s: DbScope): StoredScope {
  const saleCents = Number(s.saleCents);
  const costCents = Number(s.costCents);
  return {
    id: s.id, tier: s.tier as Tier, title: s.title, targetMarginBps: s.targetMarginBps,
    saleCents, costCents,
    marginBps: saleCents > 0 ? Math.round(((saleCents - costCents) * 10000) / saleCents) : 0,
    items: [...s.items].sort((a, b) => a.sortOrder - b.sortOrder).map((i) => ({
      kind: i.kind as LineKind, sortOrder: i.sortOrder, productId: i.productId,
      description: i.description, quantity: Number(i.quantity.toString()),
      unitCostCents: Number(i.unitCostCents), unitPriceCents: Number(i.unitPriceCents), color: i.color,
    })),
  };
}

export function createPrismaScopeStore(db: PrismaClient): ScopeStore {
  return {
    async getJob(jobId) {
      // Reject malformed ids here so they return "not found" instead of a database error.
      if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
      const j = await db.job.findUnique({ where: { id: jobId } });
      if (!j) return null;
      const job: JobAccess = {
        id: j.id, stage: j.stage as Stage, divisions: j.divisions as Division[],
        estimatorId: j.estimatorId, productionManagerId: j.productionManagerId,
      };
      return job;
    },
    async listJobs() {
      const rows = await db.job.findMany({ orderBy: { jobNumber: "desc" }, take: 200 });
      return rows.map((j): JobSummary => ({
        id: j.id, jobNumber: j.jobNumber, jobType: j.jobType, stage: j.stage as Stage,
        divisions: j.divisions as Division[], estimatorId: j.estimatorId,
        productionManagerId: j.productionManagerId,
      }));
    },
    async divisionManagerIds(divisions) {
      const rows = await db.divisionManager.findMany({ where: { division: { in: divisions } } });
      return rows.map((r) => r.userId);
    },
    async getEstimatorOwnTruck(userId) {
      const u = await db.user.findUnique({ where: { id: userId } });
      return u?.ownTruck ?? false;
    },
    async listProducts() {
      const rows = await db.product.findMany({ orderBy: { name: "asc" } });
      return rows.map((p): Product => ({
        id: p.id, sku: p.pruettSku, name: p.name, unit: p.unit,
        retailCents: Number(p.retailCents), specialOrder: p.specialOrder,
      }));
    },
    async listScopes(jobId) {
      const rows = await db.scope.findMany({ where: { jobId }, include: { items: true } });
      const order: Tier[] = ["good", "better", "best"];
      return rows.map(toStored).sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
    },
    async saveScope(jobId, scope: ComputedScope) {
      const saved = await db.$transaction(async (tx) => {
        const row = await tx.scope.upsert({
          where: { jobId_tier: { jobId, tier: scope.tier } },
          create: {
            jobId, tier: scope.tier, title: scope.title, targetMarginBps: scope.targetMarginBps,
            saleCents: BigInt(scope.saleCents), costCents: BigInt(scope.costCents),
          },
          update: {
            title: scope.title, targetMarginBps: scope.targetMarginBps,
            saleCents: BigInt(scope.saleCents), costCents: BigInt(scope.costCents),
          },
        });
        await tx.scopeItem.deleteMany({ where: { scopeId: row.id } });
        await tx.scopeItem.createMany({
          data: scope.items.map((i) => ({
            scopeId: row.id, kind: i.kind, sortOrder: i.sortOrder, productId: i.productId,
            description: i.description, quantity: i.quantity,
            unitCostCents: BigInt(i.unitCostCents), unitPriceCents: BigInt(i.unitPriceCents), color: i.color,
          })),
        });
        return tx.scope.findUniqueOrThrow({ where: { id: row.id }, include: { items: true } });
      });
      return toStored(saved);
    },
  };
}
