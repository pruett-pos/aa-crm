import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getCatalogStore } from "@/lib/catalog/index.ts";
import { pruettPriceCents } from "@/lib/rules.ts";
import { en } from "@/i18n/en.ts";
import { ProductsClient } from "./products-client.tsx";

// Admin only. The materials a scope can use. Typed by hand until the Pruett price sync exists.
export default async function ProductsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");

  const products = (await getCatalogStore().list()).map((p) => ({ ...p, builderCents: pruettPriceCents(p.retailCents) }));
  return (
    <>
      <p><Link href="/">{en.catalog.back}</Link></p>
      <h1>{en.catalog.title}</h1>
      <p className="muted">{en.catalog.help}</p>
      <ProductsClient initial={products} />
    </>
  );
}
