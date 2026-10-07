import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getCatalogStore } from "@/lib/catalog/index.ts";
import { catalogErrorResponse } from "@/lib/catalog/http.ts";
import { addProduct } from "@/lib/catalog/service.ts";
import { pruettPriceCents } from "@/lib/rules.ts";

// Role: admin only. The product catalog (materials a scope can use). `builderCents` is what A&A pays at the Builder plan,
// worked out by the shared rule, never here.
const view = (p: { id: string; sku: string; name: string; unit: string; retailCents: number; specialOrder: boolean }) => ({ ...p, builderCents: pruettPriceCents(p.retailCents) });

export async function GET() {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  return Response.json({ products: (await getCatalogStore().list()).map(view) });
}

const Body = z.object({
  sku: z.string().max(60), name: z.string().max(200), unit: z.string().max(20), price: z.string().max(20), specialOrder: z.boolean().default(false),
});

export async function POST(req: Request) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  if (!allow(`catalog:${check.user.id}`, 120, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const b = parsed.data;
  try {
    const p = await addProduct(getCatalogStore(), { sku: b.sku, name: b.name, unit: b.unit, priceText: b.price, specialOrder: b.specialOrder });
    return Response.json({ product: view(p) }, { status: 201 });
  } catch (e) {
    return catalogErrorResponse(e);
  }
}
