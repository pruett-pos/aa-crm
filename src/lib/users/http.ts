import { UserError } from "./service.ts";

const STATUS: Record<string, number> = {
  forbidden: 403, not_found: 404, duplicate_email: 409, division_taken: 409,
  cannot_change_own_role: 409, cannot_deactivate_self: 409, cannot_change_own_email: 409,
};

export function userErrorResponse(e: unknown): Response {
  if (e instanceof UserError) return Response.json({ error: e.code, message: e.message }, { status: STATUS[e.code] ?? 422 });
  throw e;
}
