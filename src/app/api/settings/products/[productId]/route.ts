import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getCatalogStore } from "@/lib/catalog/index.ts";
import { catalogErrorResponse } from "@/lib/catalog/http.ts";
import { changeProduct, removeProduct } from "@/lib/catalog/service.ts";
import { pruettPriceCents } from "@/lib/rules.ts";

type Ctx = { params: Promise<{ productId: string }> };

const Body = z.object({
  sku: z.string().max(60), name: z.string().max(200), unit: z.string().max(20), price: z.string().max(20), specialOrder: z.boolean().default(false),
});

// Role: admin only for both.
export async function PUT(req: Request, { params }: Ctx) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  if (!allow(`catalog:${check.user.id}`, 120, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { productId } = await params;
  const b = parsed.data;
  try {
    const p = await changeProduct(getCatalogStore(), productId, { sku: b.sku, name: b.name, unit: b.unit, priceText: b.price, specialOrder: b.specialOrder });
    return Response.json({ product: { ...p, builderCents: pruettPriceCents(p.retailCents) } });
  } catch (e) {
    return catalogErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  if (!allow(`catalog:${check.user.id}`, 120, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const { productId } = await params;
  try {
    await removeProduct(getCatalogStore(), productId);
    return Response.json({ ok: true });
  } catch (e) {
    return catalogErrorResponse(e);
  }
}
