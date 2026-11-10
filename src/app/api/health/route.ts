import { getDb } from "@/lib/db.ts";
import { checkHealth } from "@/lib/ops/health.ts";
import { logError } from "@/lib/ops/log.ts";

// Public on purpose (no role check): Railway's health check and uptime monitors call it. It answers only ok or down;
// it never returns error text, versions, or any data. See docs/OPERATIONS.md.
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await checkHealth(async () => {
    try {
      await getDb().$queryRaw`SELECT 1`;
    } catch (e) {
      logError("health.db_failed", e);
      throw e;
    }
  });
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
