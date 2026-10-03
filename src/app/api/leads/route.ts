import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getLeadStore } from "@/lib/leads/index.ts";
import { createLead } from "@/lib/leads/logic.ts";
import { leadErrorResponse } from "@/lib/leads/http.ts";

const Person = z.object({
  firstName: z.string().max(100), lastName: z.string().max(100),
  phone: z.string().max(40).optional(), email: z.string().max(300).optional(),
});
const Address = z.object({
  street: z.string().max(200), city: z.string().max(120), state: z.string().max(4).optional(), zip: z.string().max(12),
});
const Body = z.object({
  customer: z.union([z.object({ existingId: z.string().max(64) }), Person]),
  property: z.union([z.object({ existingId: z.string().max(64) }), Address]),
  market: z.string().max(30),
  jobType: z.string().max(30),
  divisions: z.array(z.string().max(30)).max(10),
  source: z.string().max(30),
  appointmentAt: z.string().max(40).nullable().optional(),
  overrideEstimatorId: z.string().max(64).nullable().optional(),
});

// Roles: CSR and admin (the createLeads capability).
export async function POST(req: Request) {
  const check = await requireRole("csr", "admin");
  if (!check.ok) return check.response;
  if (!allow(`lead:${check.user.id}`, 60, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const b = parsed.data;
  const appointmentAt = b.appointmentAt ? new Date(b.appointmentAt) : null;
  try {
    const r = await createLead(getLeadStore(), {
      actorId: check.user.id, customer: b.customer, property: b.property, market: b.market, jobType: b.jobType,
      divisions: b.divisions, source: b.source, appointmentAt, overrideEstimatorId: b.overrideEstimatorId ?? null,
    });
    return Response.json(r, { status: 201 });
  } catch (e) {
    return leadErrorResponse(e);
  }
}
