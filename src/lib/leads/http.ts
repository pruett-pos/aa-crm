import { LeadError } from "./logic.ts";

const STATUS: Record<string, number> = { not_found: 404, not_in_review: 409, forbidden: 403 };

export function leadErrorResponse(e: unknown): Response {
  if (e instanceof LeadError) {
    return Response.json({ error: e.code, message: e.message }, { status: STATUS[e.code] ?? 400 });
  }
  throw e;
}
