import type { Stage } from "../rules.ts";
import type { NewEntry } from "../commission/types.ts";

export const METHODS = ["check", "card", "ach", "cash", "insurance_check", "financing"] as const;
export type Method = (typeof METHODS)[number];

/** What the person recording the payment says it is. */
export type PaymentType = "deposit" | "payment" | "depreciation";

export type JobStageOrClosed = Stage | "lost" | "cancelled_after_approval";

export type PaymentJob = {
  id: string;
  jobNumber: number;
  jobType: "retail" | "insurance" | "condition_report";
  stage: JobStageOrClosed;
  estimatorId: string | null;
  estimatorOwnTruck: boolean;
  contractCents: number | null;
  costCents: number | null;
  depositRequiredCents: number;
};

export type PaymentRecord = {
  id: string;
  jobId: string;
  amountCents: number;
  method: Method;
  isDeposit: boolean;
  isDepreciation: boolean;
  reference: string | null;
  notes: string | null;
  collectedBy: string | null;
  receivedAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
  hasPhoto: boolean;
};

export type NewPayment = {
  amountCents: number;
  method: Method;
  isDeposit: boolean;
  isDepreciation: boolean;
  reference: string | null;
  notes: string | null;
  collectedBy: string;
  receivedAt: Date;
  photo: { data: Uint8Array; mime: string } | null;
};

/** Work done while the job is locked, so two payments can't both pass the overpay check. */
export interface PaymentTx {
  getJob(): Promise<PaymentJob | null>;
  list(): Promise<PaymentRecord[]>;
  insert(p: NewPayment): Promise<PaymentRecord>;
  setStage(from: JobStageOrClosed, to: Stage, userId: string): Promise<void>;
  void(paymentId: string, userId: string, reason: string, at: Date): Promise<boolean>;
  /** Commission ledger entry for a collected payment (written in the same transaction as the payment). */
  insertCommission(e: NewEntry): Promise<void>;
  /** Reverse that payment's commission entry, dated the day it was voided. No-op if none exists or already reversed. */
  reverseCommission(paymentId: string, entryDate: string): Promise<void>;
}

export interface PaymentStore {
  getPaymentJob(jobId: string): Promise<PaymentJob | null>;
  listPayments(jobId: string): Promise<PaymentRecord[]>;
  getPayment(id: string): Promise<PaymentRecord | null>;
  getPhoto(id: string): Promise<{ data: Uint8Array; mime: string } | null>;
  transaction<T>(jobId: string, fn: (tx: PaymentTx) => Promise<T>): Promise<T>;
}
