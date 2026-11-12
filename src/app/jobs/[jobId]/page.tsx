import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getAerialStore } from "@/lib/aerial/index.ts";
import { en } from "@/i18n/en.ts";
import { AerialPanel } from "./aerial-panel.tsx";

const when = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

// The lead / job overview: the appointment and the aerial roof estimate. Any signed-in user (decided by AL).
// It shows the property address but never the customer's name, phone or email.
export default async function JobOverviewPage({ params }: { params: Promise<{ jobId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { jobId } = await params;
  const job = await getAerialStore().getJob(jobId);
  if (!job) notFound();
  const a = en.aerial;

  return (
    <>
      <p><Link href="/">{en.home.back}</Link></p>
      <h1>{a.jobTitle(job.jobNumber)}</h1>
      <section className="panel">
        <dl>
          <div><dt>{a.appointment}</dt><dd>{job.appointmentAt ? when(job.appointmentAt) : a.noAppointment}</dd></div>
          <div><dt>{a.address}</dt><dd>{job.street}, {job.city}, {job.state} {job.zip}</dd></div>
          <div><dt>{a.estimator}</dt><dd>{job.estimatorName ?? a.unassigned}</dd></div>
          <div><dt>{a.trades}</dt><dd>{job.divisions.map((d) => en.leads.divisionNames[d]).join(", ")}</dd></div>
          <div><dt>{en.jobs.type}</dt><dd>{en.jobs.types[job.jobType]}</dd></div>
          <div><dt>{a.stage}</dt><dd>{job.stage.replaceAll("_", " ")}</dd></div>
        </dl>
      </section>
      <AerialPanel job={job} isAdmin={user.role === "admin"} />
    </>
  );
}
