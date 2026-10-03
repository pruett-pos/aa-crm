import { PaymentError } from "./logic.ts";

const STATUS: Record<string, number> = {
  not_found: 404, overpay: 409, duplicate: 409, already_voided: 409, job_closed: 409, no_signed_contract: 409,
};

export function paymentErrorResponse(e: unknown): Response {
  if (e instanceof PaymentError) {
    return Response.json({ error: e.code, message: e.message }, { status: STATUS[e.code] ?? 400 });
  }
  throw e;
}
