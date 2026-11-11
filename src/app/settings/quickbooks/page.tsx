import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getQboConfig, getQboStore, getQboTokenStore } from "@/lib/quickbooks/index.ts";
import { defaultClassName, defaultItemName } from "@/lib/quickbooks/logic.ts";
import { DIVISIONS_QBO, LEAD_SOURCES_QBO } from "@/lib/quickbooks/mappings.ts";
import { en } from "@/i18n/en.ts";
import { QuickBooksSettingsClient } from "./quickbooks-settings-client.tsx";

// Admin only. Shows whether the CRM can reach QuickBooks, connects or disconnects it, and edits the class and item mappings.
// No token is ever sent to the page.
export default async function QuickBooksSettingsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  const q = await searchParams;

  const config = getQboConfig();
  const stored = config ? await getQboTokenStore().get().catch(() => null) : null;
  const state = !config ? "not_configured" : !stored ? "not_connected" : stored.status === "needs_reconnect" ? "needs_reconnect" : "connected";
  const store = getQboStore();
  const [settings, classMap, itemMap] = await Promise.all([store.getSettings().catch(() => null), store.getClassMap().catch(() => ({})), store.getItemMap().catch(() => ({}))]);

  return (
    <>
      <p><Link href="/">{en.quickbooks.back}</Link></p>
      <h1>{en.quickbooks.title}</h1>
      <p className="muted">{en.quickbooks.help}</p>
      {q.connected && <p className="ok" role="status">{en.quickbooks.connectedOk}</p>}
      {q.error && <p className="error" role="status">{(en.quickbooks.errors as Record<string, string>)[q.error] ?? en.quickbooks.errors.exchange_failed}</p>}
      <QuickBooksSettingsClient
        state={state}
        company={settings?.companyName ?? null}
        environment={config?.environment ?? null}
        syncFrom={settings?.syncFrom?.toISOString() ?? null}
        classes={LEAD_SOURCES_QBO.map((k) => ({ key: k, label: (en.leads.sources as Record<string, string>)[k] ?? k, value: (classMap as Record<string, string>)[k] ?? "", fallback: defaultClassName(k) }))}
        items={DIVISIONS_QBO.map((k) => ({ key: k, label: (en.leads.divisionNames as Record<string, string>)[k] ?? k, value: (itemMap as Record<string, string>)[k] ?? "", fallback: defaultItemName(k) }))}
      />
      <p><Link href="/settings/quickbooks/sync">{en.quickbooks.openSync}</Link></p>
    </>
  );
}
