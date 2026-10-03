import { ProductionError } from "./logic.ts";

const STATUS: Record<string, number> = {
  not_found: 404, forbidden: 403,
  closed: 409, no_signed_contract: 409, deposit_not_covered: 409, materials_not_ordered: 409, bad_status: 409,
  already_ordered: 409, selections_locked: 409,
};

export function productionErrorResponse(e: unknown): Response {
  if (e instanceof ProductionError) {
    return Response.json({ error: e.code, message: e.message }, { status: STATUS[e.code] ?? 400 });
  }
  throw e;
}
