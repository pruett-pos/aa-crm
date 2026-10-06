import { CloseoutError } from "./logic.ts";

const STATUS: Record<string, number> = {
  not_found: 404, item_not_found: 404, forbidden: 403,
  wrong_stage: 409, items_locked: 409, no_contract: 409, no_punchlist: 409, punchlist_open: 409, invoice_exists: 409, no_invoice: 409,
  too_many_items: 409, email_failed: 502,
};

export function closeoutErrorResponse(e: unknown): Response {
  if (e instanceof CloseoutError) {
    return Response.json({ error: e.code, message: e.message }, { status: STATUS[e.code] ?? 400 });
  }
  throw e;
}
