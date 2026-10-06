import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getHoverOAuthConfig, getHoverTokenStore } from "@/lib/hover/index.ts";
import { en } from "@/i18n/en.ts";
import { HoverSettingsClient } from "./hover-settings-client.tsx";

// Admin only. Shows whether the CRM can reach Hover and lets an admin connect or disconnect it. No token is ever sent to the page.
export default async function HoverSettingsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  const q = await searchParams;

  const configured = getHoverOAuthConfig() !== null;
  const stored = configured ? await getHoverTokenStore().get().catch(() => null) : null;
  const state = !configured ? "not_configured" : !stored ? "not_connected" : stored.status === "needs_reconnect" ? "needs_reconnect" : "connected";

  return (
    <>
      <p><Link href="/">{en.hover.back}</Link></p>
      <h1>{en.hover.title}</h1>
      <p className="muted">{en.hover.help}</p>
      {q.connected && <p className="ok" role="status">{en.hover.connectedOk}</p>}
      {q.error && <p className="error" role="status">{(en.hover.errors as Record<string, string>)[q.error] ?? en.hover.errors.exchange_failed}</p>}
      <HoverSettingsClient state={state} refreshedAt={stored ? stored.updatedAt.toISOString() : null} />
    </>
  );
}
