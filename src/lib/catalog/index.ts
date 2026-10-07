import { getDb } from "../db.ts";
import { createPrismaCatalogStore } from "./prisma-store.ts";
import type { CatalogStore } from "./service.ts";

const g = globalThis as unknown as { __aaCatalogStore?: CatalogStore };

export function getCatalogStore(): CatalogStore {
  return (g.__aaCatalogStore ??= createPrismaCatalogStore(getDb()));
}
