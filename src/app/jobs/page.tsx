import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { canReadScopes } from "@/lib/scopes/service.ts";
import { hasRole } from "@/lib/auth/roles.ts";
import { en } from "@/i18n/en.ts";

export default async function JobsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!hasRole(user.role, ["admin", "estimator", "production_manager"])) redirect("/");

  const store = getScopeStore();
  const all = await store.listJobs();
  const visible = [];
  for (const j of all) {
    if (canReadScopes(user, j, await store.divisionManagerIds(j.divisions))) visible.push(j);
  }

  return (
    <>
      <h1>{en.jobs.title}</h1>
      {visible.length === 0 ? (
        <p className="muted">{en.jobs.empty}</p>
      ) : (
        <ul className="list">
          {visible.map((j) => (
            <li key={j.id}>
              <strong>{en.jobs.number} {j.jobNumber}</strong>{" "}
              <span className="muted">
                {en.jobs.types[j.jobType]} · {j.divisions.join(", ").replaceAll("_", " ")} · {j.stage.replaceAll("_", " ")}
              </span>{" "}
              <Link href={`/jobs/${j.id}/scope`}>{en.jobs.openScope}</Link>
            </li>
          ))}
        </ul>
      )}
      <p><Link href="/">{en.home.back}</Link></p>
    </>
  );
}
