import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { Product } from "../scopes/types.ts";
import { CatalogError, type CatalogStore, type ValidProduct } from "./service.ts";
import { STALE_RUN_MS, type PriceSyncPlan, type SyncProduct, type SyncRun, type SyncRunStore } from "./price-sync.ts";

const UUID = /^[0-9a-f-]{36}$/i;
const toProduct = (p: { id: string; pruettSku: string; name: string; unit: string; retailCents: bigint; specialOrder: boolean; costCents: bigint | null; active: boolean; source: string }): Product => ({
  id: p.id, sku: p.pruettSku, name: p.name, unit: p.unit, retailCents: Number(p.retailCents), specialOrder: p.specialOrder,
  costCents: p.costCents === null ? null : Number(p.costCents), active: p.active, source: p.source === "pruett" ? "pruett" : "manual",
});
const chunks = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const codeOf = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "");

export function createPrismaCatalogStore(db: PrismaClient): CatalogStore {
  const skuTaken = async (sku: string, exceptId?: string) =>
    (await db.product.count({ where: { pruettSku: { equals: sku, mode: "insensitive" }, ...(exceptId ? { NOT: { id: exceptId } } : {}) } })) > 0;

  return {
    async list() {
      return (await db.product.findMany({ orderBy: { name: "asc" } })).map(toProduct);
    },

    async create(p: ValidProduct) {
      if (await skuTaken(p.sku)) throw new CatalogError("duplicate_sku", "That SKU is already in the catalog");
      try {
        return toProduct(await db.product.create({ data: { pruettSku: p.sku, name: p.name, unit: p.unit, retailCents: BigInt(p.retailCents), specialOrder: p.specialOrder } }));
      } catch (e) {
        if (codeOf(e) === "P2002") throw new CatalogError("duplicate_sku", "That SKU is already in the catalog");
        throw e;
      }
    },

    async update(id: string, p: ValidProduct) {
      if (!UUID.test(id) || !(await db.product.findUnique({ where: { id } }))) throw new CatalogError("not_found");
      if (await skuTaken(p.sku, id)) throw new CatalogError("duplicate_sku", "That SKU is already in the catalog");
      try {
        return toProduct(await db.product.update({ where: { id }, data: { pruettSku: p.sku, name: p.name, unit: p.unit, retailCents: BigInt(p.retailCents), specialOrder: p.specialOrder } }));
      } catch (e) {
        if (codeOf(e) === "P2002") throw new CatalogError("duplicate_sku", "That SKU is already in the catalog");
        throw e;
      }
    },

    async remove(id: string) {
      if (!UUID.test(id) || !(await db.product.findUnique({ where: { id } }))) throw new CatalogError("not_found");
      const inUse = (await db.scopeItem.count({ where: { productId: id } })) + (await db.roofingAssemblyLine.count({ where: { productId: id } }));
      if (inUse > 0) throw new CatalogError("in_use", "A scope or a roofing assembly still uses this product");
      try {
        await db.product.delete({ where: { id } });
      } catch (e) {
        if (codeOf(e) === "P2003") throw new CatalogError("in_use", "A scope or a roofing assembly still uses this product");
        throw e;
      }
    },

    async listForSync(): Promise<SyncProduct[]> {
      return (await db.product.findMany()).map((p) => ({
        id: p.id, sku: p.pruettSku, name: p.name, unit: p.unit, retailCents: Number(p.retailCents),
        costCents: p.costCents === null ? null : Number(p.costCents), active: p.active, source: p.source === "pruett" ? "pruett" : "manual",
        description2: p.description2, category: p.category, vendor: p.vendor, vendorSku: p.vendorSku,
      }));
    },

    async applyPriceSync(plan: PriceSyncPlan, runId: number | null) {
      const now = new Date();
      await db.$transaction(async (tx) => {
        for (const part of chunks(plan.creates, 500)) {
          await tx.product.createMany({
            data: part.map((c) => ({
              pruettSku: c.sku, name: c.name, unit: c.unit, retailCents: BigInt(c.retailCents), costCents: BigInt(c.costCents), specialOrder: false,
              active: true, source: "pruett", description2: c.description2, category: c.category, vendor: c.vendor, vendorSku: c.vendorSku,
            })),
          });
        }
        const history = [];
        for (const u of plan.updates) {
          const f = u.fields;
          await tx.product.update({
            where: { id: u.id },
            data: {
              name: f.name, unit: f.unit, retailCents: BigInt(f.retailCents), costCents: BigInt(f.costCents), description2: f.description2,
              category: f.category, vendor: f.vendor, vendorSku: f.vendorSku, active: true, source: "pruett",
            },
          });
          if (u.price) {
            history.push({
              productId: u.id, changedAt: now, syncRunId: runId === null ? null : BigInt(runId),
              oldCostCents: u.price.oldCostCents === null ? null : BigInt(u.price.oldCostCents), newCostCents: BigInt(u.price.newCostCents),
              oldRetailCents: BigInt(u.price.oldRetailCents), newRetailCents: BigInt(u.price.newRetailCents),
            });
          }
        }
        if (history.length) await tx.productPriceHistory.createMany({ data: history });
        for (const part of chunks(plan.deactivateIds, 500)) await tx.product.updateMany({ where: { id: { in: part } }, data: { active: false } });
      }, { timeout: 120_000, maxWait: 10_000 });
    },
  };
}

const toRun = (r: { id: bigint; startedAt: Date; finishedAt: Date | null; trigger: string; triggeredBy: string | null; status: string; itemsSeen: number; itemsNew: number; itemsChanged: number; itemsDeactivated: number; warning: string | null; error: string | null }): SyncRun => ({
  id: Number(r.id), startedAt: r.startedAt, finishedAt: r.finishedAt, trigger: r.trigger === "cron" ? "cron" : "manual", triggeredBy: r.triggeredBy,
  status: r.status as SyncRun["status"], itemsSeen: r.itemsSeen, itemsNew: r.itemsNew, itemsChanged: r.itemsChanged, itemsDeactivated: r.itemsDeactivated,
  warning: r.warning, error: r.error,
});

export function createPrismaSyncRunStore(db: PrismaClient): SyncRunStore {
  return {
    async start(trigger, userId, now) {
      return db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(7305001)`;    // two starts at once take turns
        await tx.pruettSyncRun.updateMany({
          where: { status: "running", startedAt: { lt: new Date(now.getTime() - STALE_RUN_MS) } },
          data: { status: "error", finishedAt: now, error: "The run never finished" },
        });
        if ((await tx.pruettSyncRun.count({ where: { status: "running" } })) > 0) return null;
        return toRun(await tx.pruettSyncRun.create({ data: { startedAt: now, trigger, triggeredBy: userId } }));
      });
    },
    async finish(id, status, result, now) {
      return toRun(await db.pruettSyncRun.update({ where: { id: BigInt(id) }, data: { status, finishedAt: now, ...result } }));
    },
    async latest() {
      const r = await db.pruettSyncRun.findFirst({ orderBy: { startedAt: "desc" } });
      return r ? toRun(r) : null;
    },
  };
}
