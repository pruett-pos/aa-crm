import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { Product } from "../scopes/types.ts";
import { CatalogError, type CatalogStore, type ValidProduct } from "./service.ts";

const UUID = /^[0-9a-f-]{36}$/i;
const toProduct = (p: { id: string; pruettSku: string; name: string; unit: string; retailCents: bigint; specialOrder: boolean }): Product => ({
  id: p.id, sku: p.pruettSku, name: p.name, unit: p.unit, retailCents: Number(p.retailCents), specialOrder: p.specialOrder,
});
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
  };
}
