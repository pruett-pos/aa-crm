import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getCommissionStore } from "@/lib/commission/index.ts";
import { canAdjust, canManagePayouts, payoutOverview } from "@/lib/commission/logic.ts";
import { en } from "@/i18n/en.ts";
import { PayoutsClient } from "./payouts-client.tsx";

// Admin and accounting.
export default async function PayoutsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!canManagePayouts(user.role)) redirect("/");
  const store = getCommissionStore();
  const [overview, estimators] = await Promise.all([payoutOverview(store), store.listEstimators()]);

  return (
    <>
      <p><Link href="/">{en.home.back}</Link> · <Link href="/commissions">{en.commission.navStatements}</Link></p>
      <h1>{en.commission.payoutsTitle}</h1>
      <p className="muted">{en.commission.payoutsIntro}</p>
      <PayoutsClient
        hasSchedule={overview.schedule !== null}
        rows={overview.rows}
        uncommissioned={overview.uncommissionedPayments}
        estimators={estimators.map((e) => ({ id: e.id, fullName: e.fullName }))}
        canAdjust={canAdjust(user.role)}
      />
    </>
  );
}
