import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { hasRole } from "@/lib/auth/roles.ts";
import { getCloseoutStore } from "@/lib/closeout/index.ts";
import { CloseoutError, closeoutView } from "@/lib/closeout/logic.ts";
import { en } from "@/i18n/en.ts";
import { CloseoutClient } from "./closeout-client.tsx";

// Admin, the job's estimator, a PM with a trade on the job, an assigned crew leader (their items only), and accounting (read-only).
// closeoutView decides what each of them gets: a crew leader never receives prices or the customer's name.
export default async function CloseoutPage({ params }: { params: Promise<{ jobId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!hasRole(user.role, ["admin", "estimator", "production_manager", "crew_leader", "accounting"])) redirect("/");
  const { jobId } = await params;

  let view;
  try {
    view = await closeoutView(getCloseoutStore(), { id: user.id, role: user.role }, jobId);
  } catch (e) {
    if (e instanceof CloseoutError && e.code === "not_found") notFound();
    if (e instanceof CloseoutError && e.code === "forbidden") redirect(user.role === "crew_leader" ? "/schedule" : "/jobs");
    throw e;
  }

  const back = user.role === "crew_leader" ? { href: "/schedule", text: en.production.navSchedule } : { href: "/jobs", text: en.closeout.back };
  return (
    <>
      <p className="noprint"><Link href={back.href}>{back.text}</Link></p>
      <h1>{en.closeout.pageTitle(view.job.jobNumber)}</h1>
      <p className="muted">
        {view.job.propertyAddress}
        {view.job.customerName && <> · {view.job.customerName}</>}
        {" · "}{view.job.stage.replaceAll("_", " ")}
      </p>
      <CloseoutClient view={view} />
    </>
  );
}
