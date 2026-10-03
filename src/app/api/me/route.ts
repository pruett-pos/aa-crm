import { ROLES } from "@/lib/auth/roles.ts";
import { requireRole } from "@/lib/auth/index.ts";

// Any signed-in role may read their own profile.
export async function GET() {
  const check = await requireRole(...ROLES);
  if (!check.ok) return check.response;
  const { id, fullName, email, role } = check.user;
  return Response.json({ id, fullName, email, role });
}
