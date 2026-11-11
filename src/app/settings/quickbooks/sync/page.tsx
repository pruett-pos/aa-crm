import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getQboConfig, getQboStore } from "@/lib/quickbooks/index.ts";
import { en } from "@/i18n/en.ts";
import { SyncClient, type JobRowView } from "./sync-client.tsx";

// Admin and accounting. Counts, "Sync now", failed items with Retry, and total mismatches. Error text is QuickBooks' own
// short reason, never a token or a customer's details.
export default async function QuickBooksSyncPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin" && user.role !== "accounting") redirect("/");

  const store = getQboStore();
  const [flags, counts, failed, mismatches, pending] = await Promise.all([
    store.listDuplicateFlags("open"),
    store.counts(),
    store.listJobs({ statuses: ["failed"], limit: 100 }),
    store.listJobs({ statuses: ["done"], mismatchOnly: true, limit: 100 }),
    store.listJobs({ statuses: ["pending", "waiting", "running"], limit: 50 }),
  ]);
  const view = (j: Awaited<ReturnType<typeof store.listJobs>>[number]): JobRowView => ({
    id: j.id, kind: j.kind, attempts: j.attempts, error: j.lastError, updatedAt: j.updatedAt.toISOString(), crmCents: j.crmTotalCents, qboCents: j.qboTotalCents,
  });
  return (
    <>
      <p><Link href={user.role === "admin" ? "/settings/quickbooks" : "/"}>{en.quickbooks.back}</Link></p>
      <h1>{en.quickbooks.syncTitle}</h1>
      <SyncClient
        configured={getQboConfig() !== null}
        counts={{ queued: counts.pending + counts.waiting + counts.running, failed: counts.failed, done: counts.done, mismatch: counts.mismatch }}
        canLink={user.role === "admin"}
        duplicates={flags.map((f) => ({ customerId: f.customerId, name: f.customerName, candidates: f.candidates }))}
        failed={failed.map(view)} mismatches={mismatches.map(view)} pending={pending.map(view)}
      />
    </>
  );
}
