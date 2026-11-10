import { requireRole } from "@/lib/auth/index.ts";
import { recordAudit } from "@/lib/audit/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getSyncRunStore, runPruettSync } from "@/lib/catalog/index.ts";
import { syncRunView } from "@/lib/catalog/price-sync.ts";

// Role: admin only, for both. GET = how the last Pruett price sync went. POST = run it now ("Sync from Pruett now").
export async function GET() {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const run = await getSyncRunStore().latest();
  return Response.json({ run: run ? syncRunView(run) : null });
}

export async function POST() {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  if (!allow(`pruett-sync:${check.user.id}`, 10, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const run = await runPruettSync({ trigger: "manual", userId: check.user.id });
  if (run.status === "busy") return Response.json({ error: "sync_running" }, { status: 409 });
  await recordAudit(check.user, {
    action: "settings.price_sync_run", entityType: "pruett_sync", entityId: String(run.id),
    summary: `Ran the Pruett price sync by hand: ${run.status} (${run.itemsNew} new, ${run.itemsChanged} changed, ${run.itemsDeactivated} deactivated)`,
    details: { status: run.status, seen: run.itemsSeen, new: run.itemsNew, changed: run.itemsChanged, deactivated: run.itemsDeactivated },
  });
  return Response.json({ run: syncRunView(run) });
}
