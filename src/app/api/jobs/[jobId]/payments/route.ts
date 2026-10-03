import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getPaymentStore } from "@/lib/payments/index.ts";
import {
  PaymentError, canRecordPayments, canSeeCommissionEarned, canVoidPayments, commissionEarnedSoFar, recordPayment, summarize,
} from "@/lib/payments/logic.ts";
import { paymentErrorResponse } from "@/lib/payments/http.ts";
import type { PaymentType } from "@/lib/payments/types.ts";

type Ctx = { params: Promise<{ jobId: string }> };

// Roles: admin, accounting, or the job's own estimator. PMs, CSRs and crew get 403.
export async function GET(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "accounting", "estimator");
  if (!check.ok) return check.response;
  const { jobId } = await params;
  const store = getPaymentStore();
  const job = await store.getPaymentJob(jobId);
  if (!job) return Response.json({ error: "not_found" }, { status: 404 });
  if (!canRecordPayments(check.user, job)) return Response.json({ error: "forbidden" }, { status: 403 });

  const payments = await store.listPayments(jobId);
  const summary = summarize(job, payments);
  const commission = canSeeCommissionEarned(check.user, job) ? commissionEarnedSoFar(job, summary.collectedCents) : null;
  return Response.json({
    job: { id: job.id, jobNumber: job.jobNumber, stage: job.stage },
    summary,
    commissionEarnedCents: commission?.earnedCents ?? null,
    canVoid: canVoidPayments(check.user.role),
    payments: payments.map((p) => ({ ...p, receivedAt: p.receivedAt.toISOString(), voidedAt: p.voidedAt?.toISOString() ?? null })),
  });
}

const TYPES: PaymentType[] = ["deposit", "payment", "depreciation"];

// Multipart so the check photo can ride along. IP and recorder identity come from the session, never the form.
export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "accounting", "estimator");
  if (!check.ok) return check.response;
  const { user } = check;
  if (!allow(`pay:${user.id}`, 30, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { jobId } = await params;

  const store = getPaymentStore();
  const job = await store.getPaymentJob(jobId);
  if (!job) return Response.json({ error: "not_found" }, { status: 404 });
  if (!canRecordPayments(user, job)) return Response.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  if (!form) return Response.json({ error: "invalid_body" }, { status: 400 });
  const text = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : "");
  const type = text("type") as PaymentType;
  if (!TYPES.includes(type)) return Response.json({ error: "invalid_body" }, { status: 400 });

  const file = form.get("photo");
  let photo: { data: Uint8Array } | null = null;
  if (file instanceof File && file.size > 0) {
    if (file.size > 6 * 1024 * 1024) return Response.json({ error: "photo_invalid" }, { status: 400 });
    photo = { data: new Uint8Array(await file.arrayBuffer()) };
  }

  try {
    const r = await recordPayment(store, {
      jobId, recorder: { id: user.id, role: user.role }, amountText: text("amount"), type,
      method: text("method"), reference: text("reference"), notes: text("notes"), photo,
    });
    return Response.json({ id: r.payment.id, stageChanged: r.stageChanged, summary: r.summary }, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentError) return paymentErrorResponse(e);
    throw e;
  }
}
