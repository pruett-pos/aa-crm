import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getCommissionStore } from "@/lib/commission/index.ts";
import { canSetSchedule } from "@/lib/commission/logic.ts";
import { en } from "@/i18n/en.ts";
import { ScheduleForm } from "./schedule-form.tsx";

// Admin only.
export default async function CommissionSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!canSetSchedule(user.role)) redirect("/");
  const schedule = await getCommissionStore().getSchedule();

  return (
    <>
      <p><Link href="/">{en.home.back}</Link></p>
      <h1>{en.commission.scheduleTitle}</h1>
      <p className="muted">{en.commission.scheduleHelp}</p>
      <ScheduleForm initial={schedule} />
    </>
  );
}
