import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getLeadStore } from "@/lib/leads/index.ts";
import { en } from "@/i18n/en.ts";
import { SpendGrid } from "./spend-grid.tsx";

// Admin only.
export default async function MarketingSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");

  // This month and the five before it, in UTC to match how months are stored.
  const now = new Date();
  const months: string[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const spend = await getLeadStore().listSpend(months[months.length - 1], months[0]);

  return (
    <>
      <p><Link href="/">{en.home.back}</Link></p>
      <h1>{en.leads.spendTitle}</h1>
      <p className="muted">{en.leads.spendHelp}</p>
      <SpendGrid months={months} initial={spend.map((s) => ({ source: s.source, month: s.month, dollars: (s.spendCents / 100).toFixed(2) }))} />
    </>
  );
}
