import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getLeadStore } from "@/lib/leads/index.ts";
import { createWebsiteLead } from "@/lib/leads/logic.ts";
import { normalizePhone } from "@/lib/leads/phone.ts";
import { leadErrorResponse } from "@/lib/leads/http.ts";

const Body = z.object({
  firstName: z.string().max(100), lastName: z.string().max(100),
  phone: z.string().max(40).optional(), email: z.string().max(300).optional(),
  street: z.string().max(200), city: z.string().max(120), state: z.string().max(4).optional(), zip: z.string().max(12),
  division: z.string().max(30),
  message: z.string().max(2000).optional(),
  company: z.string().max(200).optional(), // honeypot: real visitors never see or fill this
});

function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const HOUR = 60 * 60 * 1000;

// PUBLIC by necessity: called by the website's form handler, not by a signed-in user.
// Protected by a shared secret header, a honeypot, strict validation and rate limits.
// The WordPress server makes the call, so limits are per secret holder, per phone number,
// and per visitor IP when the form passes one in `x-client-ip`.
export async function POST(req: Request) {
  const expected = process.env.WEBSITE_FORM_SECRET;
  if (!expected) return Response.json({ error: "disabled" }, { status: 503 });
  if (!secretMatches(req.headers.get("x-form-secret"), expected)) return Response.json({ error: "unauthorized" }, { status: 401 });

  if (!allow("website:all", 120, HOUR)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const visitor = req.headers.get("x-client-ip")?.slice(0, 64);
  if (visitor && !allow(`website:ip:${visitor}`, 10, HOUR)) return Response.json({ error: "rate_limited" }, { status: 429 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { company, ...lead } = parsed.data;

  // Bots fill every field. Pretend it worked and save nothing.
  if (company && company.trim() !== "") return Response.json({ ok: true }, { status: 201 });

  const digits = lead.phone ? normalizePhone(lead.phone) : null;
  if (digits && !allow(`website:phone:${digits}`, 3, HOUR)) return Response.json({ error: "rate_limited" }, { status: 429 });

  try {
    await createWebsiteLead(getLeadStore(), lead);
    return Response.json({ ok: true }, { status: 201 }); // never echo job ids back to the public
  } catch (e) {
    return leadErrorResponse(e);
  }
}
