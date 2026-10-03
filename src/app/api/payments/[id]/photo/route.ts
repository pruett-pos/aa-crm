import { requireRole } from "@/lib/auth/index.ts";
import { getPaymentStore } from "@/lib/payments/index.ts";
import { canRecordPayments } from "@/lib/payments/logic.ts";

type Ctx = { params: Promise<{ id: string }> };

// Roles: admin, accounting, or the job's own estimator.
export async function GET(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "accounting", "estimator");
  if (!check.ok) return check.response;
  const { id } = await params;
  const store = getPaymentStore();
  const payment = await store.getPayment(id);
  if (!payment) return Response.json({ error: "not_found" }, { status: 404 });
  const job = await store.getPaymentJob(payment.jobId);
  if (!job) return Response.json({ error: "not_found" }, { status: 404 });
  if (!canRecordPayments(check.user, job)) return Response.json({ error: "forbidden" }, { status: 403 });

  const photo = await store.getPhoto(id);
  if (!photo) return Response.json({ error: "not_found" }, { status: 404 });
  return new Response(Buffer.from(photo.data), {
    headers: { "content-type": photo.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}
