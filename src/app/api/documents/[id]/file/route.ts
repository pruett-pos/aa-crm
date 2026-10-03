import { requireRole } from "@/lib/auth/index.ts";
import { ROLES } from "@/lib/auth/roles.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { getContractStore } from "@/lib/contracts/index.ts";
import { authorizeJob } from "@/lib/contracts/access.ts";

type Ctx = { params: Promise<{ id: string }> };

// Roles: admin, the job's own estimator, and the division's Production Manager from contract onward.
export async function GET(_req: Request, { params }: Ctx) {
  const check = await requireRole(...ROLES);
  if (!check.ok) return check.response;
  const { id } = await params;

  const doc = await getContractStore().getDocument(id);
  if (!doc || doc.status === "cancelled") return Response.json({ error: "not_found" }, { status: 404 });
  const auth = await authorizeJob(getScopeStore(), check.user, doc.jobId, "read");
  if ("response" in auth) return auth.response;

  const bytes = doc.status === "signed" ? doc.signedData : doc.unsignedData;
  if (!bytes) return Response.json({ error: "not_found" }, { status: 404 });
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="contract-${doc.status}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
