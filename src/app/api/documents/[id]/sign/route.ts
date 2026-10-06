import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import { getContractStore } from "@/lib/contracts/index.ts";
import { authorizeJob, clientIp, contractErrorResponse } from "@/lib/contracts/access.ts";
import { finalizeSignature } from "@/lib/contracts/sign.ts";
import { sendColorsNeededEmail, sendSignedContract } from "@/integrations/resend/index.ts";
import { getWorkOrderStore } from "@/lib/workorders/index.ts";
import { onContractSigned } from "@/lib/workorders/logic.ts";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({
  consent: z.boolean(),
  signerName: z.string().max(200),
  signerEmail: z.string().max(300),
  signaturePng: z.string().max(900_000),
});

// Roles: admin, or the job's own estimator running the signing session on their device.
// IP and user agent come from the request itself, never from the body.
export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  const { user } = check;
  if (!allow(`sign:${user.id}`, 10, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { id } = await params;

  const store = getContractStore();
  const doc = await store.getDocument(id);
  if (!doc) return Response.json({ error: "not_found" }, { status: 404 });
  const auth = await authorizeJob(getScopeStore(), user, doc.jobId, "write");
  if ("response" in auth) return auth.response;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });

  try {
    const result = await finalizeSignature(store, {
      documentId: id, userId: user.id, consent: parsed.data.consent,
      signerName: parsed.data.signerName, signerEmail: parsed.data.signerEmail,
      signaturePngDataUrl: parsed.data.signaturePng,
      ip: clientIp(req), userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
    });
    // The signature stands even if the email fails; the UI offers a download instead.
    let emailed = true;
    try {
      await sendSignedContract(result.signerEmail, result.signerName, result.jobNumber, result.signedData);
    } catch (e) {
      emailed = false;
      console.error("Signed-contract email failed:", e instanceof Error ? e.message : e);
    }
    // Now that it is signed: draft the work orders and tell the estimator to enter colors. Never throws and never undoes the signature.
    const afterSigning = await onContractSigned(getWorkOrderStore(), sendColorsNeededEmail, doc.jobId);
    return Response.json({ status: "signed", emailed, signedSha256: result.signedSha256, workOrders: afterSigning.created.length });
  } catch (e) {
    return contractErrorResponse(e);
  }
}
