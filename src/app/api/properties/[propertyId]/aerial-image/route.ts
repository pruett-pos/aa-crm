import { requireRole } from "@/lib/auth/index.ts";
import { ROLES } from "@/lib/auth/roles.ts";
import { getAerialStore } from "@/lib/aerial/index.ts";

type Ctx = { params: Promise<{ propertyId: string }> };

// Roles: anyone signed in (decided by AL: the aerial estimate is visible to every user). Never a public link.
export async function GET(_req: Request, { params }: Ctx) {
  const check = await requireRole(...ROLES);
  if (!check.ok) return check.response;
  const { propertyId } = await params;
  const image = await getAerialStore().getImage(propertyId);
  if (!image) return Response.json({ error: "not_found" }, { status: 404 });
  return new Response(Buffer.from(image.data), {
    headers: { "content-type": image.mime, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
  });
}
