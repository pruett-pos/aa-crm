import { WorkOrderError } from "./logic.ts";

const STATUS: Record<string, number> = {
  not_found: 404, no_work_order: 404, line_not_found: 404, forbidden: 403,
  no_signed_contract: 409, closed: 409, not_draft: 409, not_issued: 409, colors_missing: 409, trade_started: 409, not_a_hand_line: 409, too_many_lines: 409,
  division_not_on_job: 400, text_invalid: 422, quantity_invalid: 422, unit_invalid: 422,
};

export function workOrderErrorResponse(e: unknown): Response {
  if (e instanceof WorkOrderError) {
    return Response.json({ error: e.code, message: e.message, count: e.count }, { status: STATUS[e.code] ?? 400 });
  }
  throw e;
}
