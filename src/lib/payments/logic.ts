import {
  PAYMENT_MAX_CENTS, STAGES, balanceDueCents, commissionEarnedCents, depositDueCents,
  grossMarginBps, nextStage, parseDollarsToCents, wouldOverpay,
} from "../rules.ts";
import type { Role } from "../auth/roles.ts";
import { buildAccrual } from "../commission/logic.ts";
import { localDate } from "../commission/periods.ts";
import type { AuthUser } from "../auth/store.ts";
import {
  METHODS, type JobStageOrClosed, type Method, type PaymentJob, type PaymentRecord, type PaymentStore, type PaymentType,
} from "./types.ts";

export type PaymentErrorCode =
  | "not_found" | "amount_invalid" | "amount_too_large" | "method_invalid" | "reference_required"
  | "photo_required" | "photo_invalid" | "depreciation_not_allowed" | "no_signed_contract" | "job_closed"
  | "overpay" | "duplicate" | "already_voided" | "reason_required";

export class PaymentError extends Error {
  code: PaymentErrorCode;
  constructor(code: PaymentErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

// ---------- Who may do what ----------
/** Admin, accounting, and the job's own estimator can record and see payments. PMs, CSRs and crew cannot. */
export function canRecordPayments(user: AuthUser, job: Pick<PaymentJob, "estimatorId">): boolean {
  if (user.role === "admin" || user.role === "accounting") return true;
  return user.role === "estimator" && job.estimatorId === user.id;
}
export const canViewPayments = canRecordPayments;
export function canVoidPayments(role: Role): boolean {
  return role === "admin" || role === "accounting";
}
/** Commission earned is shown to the job's own estimator, admin and accounting. */
export function canSeeCommissionEarned(user: AuthUser, job: Pick<PaymentJob, "estimatorId">): boolean {
  return user.role === "admin" || user.role === "accounting" || (user.role === "estimator" && job.estimatorId === user.id);
}

// ---------- Photo ----------
const PHOTO_MAX_BYTES = 6 * 1024 * 1024;
export function sniffImageMime(b: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png";
  const riff = String.fromCharCode(...b.slice(0, 4)), webp = String.fromCharCode(...b.slice(8, 12));
  if (b.length > 12 && riff === "RIFF" && webp === "WEBP") return "image/webp";
  return null;
}

// ---------- Summary ----------
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const liveOnly = (ps: PaymentRecord[]) => ps.filter((p) => !p.voidedAt);

export type PaymentSummary = {
  contractCents: number;
  depositRequiredCents: number;
  depositPaidCents: number;
  depositDueCents: number;
  collectedCents: number;
  balanceDueCents: number;
  depositCovered: boolean;
};

export function summarize(job: PaymentJob, payments: PaymentRecord[]): PaymentSummary {
  const live = liveOnly(payments);
  const collected = sum(live.map((p) => p.amountCents));
  const depositPaid = sum(live.filter((p) => p.isDeposit).map((p) => p.amountCents));
  const contract = job.contractCents ?? 0;
  return {
    contractCents: contract,
    depositRequiredCents: job.depositRequiredCents,
    depositPaidCents: depositPaid,
    depositDueCents: depositDueCents(job.depositRequiredCents, depositPaid),
    collectedCents: collected,
    balanceDueCents: balanceDueCents(contract, collected),
    depositCovered: job.depositRequiredCents > 0 && depositPaid >= job.depositRequiredCents,
  };
}

/** Commission earned so far: paid on amount collected, at the job's margin. Null if margin is unknown. */
export function commissionEarnedSoFar(job: PaymentJob, collectedCents: number): { rateMarginBps: number; earnedCents: number } | null {
  if (!job.contractCents || job.costCents === null) return null;
  const marginBps = grossMarginBps(job.contractCents, job.costCents);
  return { rateMarginBps: marginBps, earnedCents: commissionEarnedCents(collectedCents, marginBps, job.estimatorOwnTruck) };
}

// ---------- Recording ----------
const SIGNED_INDEX = STAGES.indexOf("contract_signed");
const DUPLICATE_WINDOW_MS = 60_000;

export type RecordInput = {
  jobId: string;
  recorder: { id: string; role: Role };
  amountText: string;
  type: PaymentType;
  method: string;
  reference?: string | null;
  notes?: string | null;
  photo?: { data: Uint8Array } | null;
};

export async function recordPayment(
  store: PaymentStore, input: RecordInput, now: () => Date = () => new Date(),
): Promise<{ payment: PaymentRecord; stageChanged: boolean; summary: PaymentSummary }> {
  const amount = parseDollarsToCents(input.amountText);
  if (amount === null) throw new PaymentError("amount_invalid");
  if (amount > PAYMENT_MAX_CENTS) throw new PaymentError("amount_too_large");
  if (!(METHODS as readonly string[]).includes(input.method)) throw new PaymentError("method_invalid");
  const method = input.method as Method;
  const reference = input.reference?.trim().slice(0, 120) || null;
  const notes = input.notes?.trim().slice(0, 500) || null;
  if ((method === "card" || method === "ach") && !reference) {
    throw new PaymentError("reference_required", "Enter the Helcim transaction number or bank reference");
  }

  let photo: { data: Uint8Array; mime: string } | null = null;
  if (input.photo) {
    const mime = input.photo.data.length <= PHOTO_MAX_BYTES ? sniffImageMime(input.photo.data) : null;
    if (!mime) throw new PaymentError("photo_invalid");
    photo = { data: input.photo.data, mime };
  } else if (method === "check" && input.recorder.role === "estimator") {
    throw new PaymentError("photo_required", "Take a photo of the check");
  }

  return store.transaction(input.jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new PaymentError("not_found");
    if (job.stage === "lost" || job.stage === "cancelled_after_approval") throw new PaymentError("job_closed");
    if (STAGES.indexOf(job.stage) < SIGNED_INDEX || !job.contractCents) throw new PaymentError("no_signed_contract");
    if (input.type === "depreciation" && job.jobType !== "insurance") throw new PaymentError("depreciation_not_allowed");

    const existing = liveOnly(await tx.list());
    const collected = sum(existing.map((p) => p.amountCents));
    if (wouldOverpay(job.contractCents, collected, amount)) {
      throw new PaymentError("overpay", "This would collect more than the contract total");
    }
    const at = now();
    const dup = existing.find((p) =>
      p.amountCents === amount && p.method === method && (p.reference ?? null) === reference &&
      at.getTime() - p.receivedAt.getTime() < DUPLICATE_WINDOW_MS);
    if (dup) throw new PaymentError("duplicate", "The same payment was just recorded");

    const payment = await tx.insert({
      amountCents: amount, method, isDeposit: input.type === "deposit",
      isDepreciation: input.type === "depreciation", reference, notes,
      collectedBy: input.recorder.id, receivedAt: at, photo,
    });

    const accrual = buildAccrual(job, payment, localDate(at));
    if (accrual) await tx.insertCommission(accrual);

    const after = [...existing, payment];
    const summary = summarize(job, after);
    let stageChanged = false;
    if (input.type === "deposit" && job.stage === "contract_signed" && summary.depositCovered) {
      const next = nextStage("contract_signed", job.jobType === "insurance" ? "insurance" : "retail", job.depositRequiredCents);
      if (next === "deposit_collected") {
        await tx.setStage(job.stage, next, input.recorder.id);
        stageChanged = true;
      }
    }
    return { payment, stageChanged, summary };
  });
}

// ---------- Voiding ----------
export async function voidPayment(
  store: PaymentStore, a: { paymentId: string; userId: string; reason: string }, now: () => Date = () => new Date(),
): Promise<{ depositNoLongerCovered: boolean }> {
  const reason = a.reason.trim();
  if (reason.length < 3 || reason.length > 300) throw new PaymentError("reason_required");
  const p = await store.getPayment(a.paymentId);
  if (!p) throw new PaymentError("not_found");
  if (p.voidedAt) throw new PaymentError("already_voided");

  return store.transaction(p.jobId, async (tx) => {
    const ok = await tx.void(p.id, a.userId, reason, now());
    if (!ok) throw new PaymentError("already_voided");
    await tx.reverseCommission(p.id, localDate(now()));
    const job = await tx.getJob();
    if (!job) throw new PaymentError("not_found");
    const summary = summarize(job, await tx.list());
    const pastDeposit = job.stage !== "lost" && job.stage !== "cancelled_after_approval"
      && STAGES.indexOf(job.stage as (typeof STAGES)[number]) >= STAGES.indexOf("deposit_collected");
    // Stages are never moved backward automatically; the screen flags it for a person to decide.
    return { depositNoLongerCovered: pastDeposit && job.depositRequiredCents > 0 && !summary.depositCovered };
  });
}

export type { JobStageOrClosed };
