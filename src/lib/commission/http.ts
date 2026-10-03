import { CommissionError } from "./logic.ts";

const STATUS: Record<string, number> = {
  not_found: 404, forbidden: 403, already_paid: 409, period_open: 409, nothing_to_pay: 409, no_schedule: 409,
};

export function commissionErrorResponse(e: unknown): Response {
  if (e instanceof CommissionError) {
    return Response.json({ error: e.code, message: e.message }, { status: STATUS[e.code] ?? 400 });
  }
  throw e;
}
