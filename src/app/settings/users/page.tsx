import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getUserAdminStore } from "@/lib/users/index.ts";
import { listUsers } from "@/lib/users/service.ts";
import { en } from "@/i18n/en.ts";
import { UsersClient } from "./users-client.tsx";

// Admin only.
export default async function UsersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");

  const users = (await listUsers(getUserAdminStore(), user)).map((u) => ({ ...u, createdAt: u.createdAt.toISOString() }));
  return (
    <>
      <p><Link href="/">{en.users.back}</Link></p>
      <h1>{en.users.title}</h1>
      <p className="muted">{en.users.help}</p>
      <p><Link href="/settings/audit">{en.users.auditLink}</Link></p>
      <UsersClient initial={users} meId={user.id} />
    </>
  );
}
