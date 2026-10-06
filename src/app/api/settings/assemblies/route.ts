import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getAssemblyStore } from "@/lib/estimating/index.ts";
import { estimatingErrorResponse } from "@/lib/estimating/http.ts";
import { LABOR_BASIS, LABOR_ROLES, MATERIAL_BASIS, MATERIAL_ROLES } from "@/lib/estimating/roofing.ts";
import { validateAssemblyEdit } from "@/lib/estimating/service.ts";
import { getScopeStore } from "@/lib/scopes/index.ts";
import type { Tier } from "@/lib/scopes/types.ts";

// Role: admin only. The roofing assembly settings: which catalog product fills each role in each package, how much one unit
// covers, and the labor lines with their cost rates.
export async function GET() {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const products = await getScopeStore().listProducts();
  return Response.json({
    lines: await getAssemblyStore().list(),
    products: products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, unit: p.unit })),
    materialRoles: MATERIAL_ROLES.map((role) => ({ role, ...MATERIAL_BASIS[role] })),
    laborRoles: LABOR_ROLES.map((role) => ({ role, ...LABOR_BASIS[role] })),
  });
}

const Body = z.object({
  tier: z.string().max(10),
  role: z.string().max(40),
  productId: z.string().max(64).nullable().optional(),
  description: z.string().max(400).nullable().optional(),
  unit: z.string().max(20).nullable().optional(),
  coverage: z.number().finite().nullable().optional(),
  unitCostCents: z.number().int().nullable().optional(),
  enabled: z.boolean().default(true),
});

export async function PUT(req: Request) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  if (!allow(`assembly:${check.user.id}`, 120, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const b = parsed.data;
  try {
    const products = new Set((await getScopeStore().listProducts()).map((p) => p.id));
    const row = validateAssemblyEdit({
      tier: b.tier as Tier, role: b.role, productId: b.productId ?? null, description: b.description ?? null, unit: b.unit ?? null,
      coverage: b.coverage ?? null, unitCostCents: b.unitCostCents ?? null, enabled: b.enabled,
    }, products);
    await getAssemblyStore().upsert(row, check.user.id);
    return Response.json({ ok: true });
  } catch (e) {
    return estimatingErrorResponse(e);
  }
}
