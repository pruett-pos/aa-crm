import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getCatalogStore, getSyncRunStore } from "@/lib/catalog/index.ts";
import { syncRunView } from "@/lib/catalog/price-sync.ts";
import { materialUnitCostCents } from "@/lib/rules.ts";
import { en } from "@/i18n/en.ts";
import { ProductsClient } from "./products-client.tsx";
import { SyncPanel } from "./sync-panel.tsx";

// Admin only. The materials a scope can use: kept current by the nightly Pruett price sync, plus any added by hand.
export default async function ProductsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");

  const [list, lastRun] = await Promise.all([getCatalogStore().list(), getSyncRunStore().latest()]);
  const products = list.map((p) => ({ ...p, builderCents: materialUnitCostCents(p), source: p.source ?? "manual", active: p.active !== false }));
  return (
    <>
      <p><Link href="/">{en.catalog.back}</Link></p>
      <h1>{en.catalog.title}</h1>
      <p className="muted">{en.catalog.help}</p>
      <SyncPanel initial={lastRun ? syncRunView(lastRun) : null} />
      <ProductsClient initial={products} />
    </>
  );
}
