import { ManageError } from "./logic.ts";

const STATUS: Record<string, number> = {
  not_found: 404, project_not_found: 404, forbidden: 403,
  already_linked: 409, already_linked_elsewhere: 409, not_linked: 409, project_deleted: 409,
  not_configured: 503, service_error: 502,
};

export function companyCamErrorResponse(e: unknown): Response {
  if (e instanceof ManageError) return Response.json({ error: e.code, message: e.message }, { status: STATUS[e.code] ?? 400 });
  throw e;
}
