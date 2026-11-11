import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { recordAudit } from "@/lib/audit/index.ts";
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
    const was = (await getCatalogStore().list()).find((x) => x.id === productId);
    const p = await changeProduct(getCatalogStore(), productId, { sku: b.sku, name: b.name, unit: b.unit, priceText: b.price, specialOrder: b.specialOrder });
    await recordAudit(check.user, {
      action: "settings.product_updated", entityType: "product", entityId: p.id,
      summary: `Updated product ${p.sku} (${p.name})${was && was.retailCents !== p.retailCents ? `: retail ${(was.retailCents / 100).toFixed(2)} to ${(p.retailCents / 100).toFixed(2)}` : ""}`,
      details: { from: was && { sku: was.sku, name: was.name, unit: was.unit, retailCents: was.retailCents, specialOrder: was.specialOrder }, to: { sku: p.sku, name: p.name, unit: p.unit, retailCents: p.retailCents, specialOrder: p.specialOrder } },
    });
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
    const was = (await getCatalogStore().list()).find((x) => x.id === productId);
    await removeProduct(getCatalogStore(), productId);
    await recordAudit(check.user, { action: "settings.product_removed", entityType: "product", entityId: productId, summary: `Removed product ${was ? `${was.sku} (${was.name})` : productId}`, details: was && { sku: was.sku, name: was.name, retailCents: was.retailCents } });
    return Response.json({ ok: true });
  } catch (e) {
    return catalogErrorResponse(e);
  }
}
