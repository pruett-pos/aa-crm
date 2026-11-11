import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getAuditStore } from "@/lib/audit/index.ts";
import { en } from "@/i18n/en.ts";

// Admin only. Read-only.
export default async function AuditPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");

  const entries = await getAuditStore().list(200);
  const when = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });
  return (
    <>
      <p><Link href="/settings/users">{en.audit.back}</Link></p>
      <h1>{en.audit.title}</h1>
      <p className="muted">{en.audit.help}</p>
      {entries.length === 0 ? <p className="muted">{en.audit.empty}</p> : (
        <table className="lines">
          <thead><tr><th>{en.audit.when}</th><th>{en.audit.who}</th><th>{en.audit.what}</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}><td>{when(e.at)}</td><td>{e.actorEmail ?? en.audit.system}</td><td>{e.summary}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
