import { MeasurementError } from "./parse.ts";

const STATUS: Record<string, number> = {
  not_found: 404, no_match: 404, forbidden: 403, locked: 409, model_not_ready: 409, search_too_short: 400,
  hover_not_connected: 503, hover_error: 502, no_roof_data: 422, no_roof_area: 422, invalid_value: 422,
};

export function measurementErrorResponse(e: unknown): Response {
  if (e instanceof MeasurementError) {
    return Response.json({ error: e.code, message: e.message, field: e.field }, { status: STATUS[e.code] ?? 400 });
  }
  throw e;
}
