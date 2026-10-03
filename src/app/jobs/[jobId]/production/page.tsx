import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { hasRole } from "@/lib/auth/roles.ts";
import { getProductionStore } from "@/lib/production/index.ts";
import { ProductionError, productionView } from "@/lib/production/logic.ts";
import { en } from "@/i18n/en.ts";
import { PhotosPanel } from "./photos-panel.tsx";
import { ProductionClient } from "./production-client.tsx";

// Admin and the job's estimator see the whole job; a PM the trades they manage; a crew leader the trades assigned to them.
export default async function ProductionPage({ params }: { params: Promise<{ jobId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!hasRole(user.role, ["admin", "estimator", "production_manager", "crew_leader"])) redirect("/");
  const { jobId } = await params;

  let view;
  try {
    view = await productionView(getProductionStore(), { id: user.id, role: user.role }, jobId);
  } catch (e) {
    if (e instanceof ProductionError && e.code === "not_found") notFound();
    if (e instanceof ProductionError && e.code === "forbidden") redirect(user.role === "crew_leader" ? "/schedule" : "/jobs");
    throw e;
  }

  return (
    <>
      <p className="noprint"><Link href={user.role === "crew_leader" ? "/schedule" : "/jobs"}>{user.role === "crew_leader" ? en.production.navSchedule : en.production.back}</Link></p>
      <h1>{en.production.pageTitle(view.job.jobNumber)}</h1>
      <p className="muted">
        {view.job.propertyAddress}
        {view.job.customerName && <> · {view.job.customerName}</>}
        {" · "}{view.job.stage.replaceAll("_", " ")}
      </p>
      <PhotosPanel jobId={view.job.id} />
      <ProductionClient view={view} />
    </>
  );
}
