import { CatalogError } from "./service.ts";

const STATUS: Record<string, number> = { not_found: 404, invalid_product: 422, duplicate_sku: 409, in_use: 409 };

export function catalogErrorResponse(e: unknown): Response {
  if (e instanceof CatalogError) return Response.json({ error: e.code, message: e.message }, { status: STATUS[e.code] ?? 400 });
  throw e;
}
