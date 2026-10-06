import { EstimatingError } from "./service.ts";

const STATUS: Record<string, number> = {
  not_found: 404, forbidden: 403, contract_signed: 409, no_measurements: 409, scope_exists: 409, no_assembly: 409,
  division_not_supported: 400, invalid_waste: 400, invalid_scope: 422, invalid_assembly: 422,
};

export function estimatingErrorResponse(e: unknown): Response {
  if (e instanceof EstimatingError) {
    return Response.json({ error: e.code, message: e.message, skipped: e.skipped }, { status: STATUS[e.code] ?? 400 });
  }
  throw e;
}
