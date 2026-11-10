import { requireRole } from "@/lib/auth/index.ts";
import { getQboConfig, getQboStore, getQboTokenStore } from "@/lib/quickbooks/index.ts";
import { revokeQboToken } from "@/integrations/quickbooks/oauth.ts";

// Role: admin only. Tells Intuit to forget the grant (best effort), then forgets the stored tokens. Queued pushes wait.
export async function POST() {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const tokens = getQboTokenStore();
  const config = getQboConfig();
  const stored = await tokens.get().catch(() => null);
  if (config && stored) await revokeQboToken(config, stored.refreshToken, (u, i) => fetch(u, i));
  await tokens.disconnect();
  await getQboStore().clearConnection();
  return Response.json({ ok: true });
}
