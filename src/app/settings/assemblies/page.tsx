import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getAssemblyStore } from "@/lib/estimating/index.ts";
import { LABOR_BASIS, LABOR_ROLES, MATERIAL_BASIS, MATERIAL_ROLES } from "@/lib/estimating/roofing.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { en } from "@/i18n/en.ts";
import { AssembliesClient } from "./assemblies-client.tsx";

// Admin only. Which product fills each roofing material in each package, how much one unit covers, and the labor lines with their rates.
export default async function AssembliesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");

  const [lines, products] = await Promise.all([getAssemblyStore().list(), getScopeStore().listProducts()]);
  return (
    <>
      <p><Link href="/">{en.assemblies.back}</Link></p>
      <h1>{en.assemblies.title}</h1>
      <p className="muted">{en.assemblies.help}</p>
      <p className="warn small-text">{en.assemblies.sampleWarn}</p>
      <AssembliesClient
        lines={lines}
        products={products.map((p) => ({ id: p.id, name: p.name, unit: p.unit }))}
        materialRoles={MATERIAL_ROLES.map((role) => ({ role, ...MATERIAL_BASIS[role] }))}
        laborRoles={LABOR_ROLES.map((role) => ({ role, ...LABOR_BASIS[role] }))}
      />
    </>
  );
}
