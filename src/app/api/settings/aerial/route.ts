import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { recordAudit } from "@/lib/audit/index.ts";
import { getAerialStore } from "@/lib/aerial/index.ts";
import { AerialError, validateSettings } from "@/lib/aerial/logic.ts";

const Body = z.object({
  enabled: z.boolean(), wastePct: z.number(), correctionPct: z.number(),
  eavesFtPerSq: z.number(), rakesFtPerSq: z.number(), ridgesHipsFtPerSq: z.number(), valleysFtPerSq: z.number(),
});

// Roles: admin only.
export async function GET() {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  return Response.json({ settings: await getAerialStore().getSettings() });
}

export async function PUT(req: Request) {
  const check = await requireRole("admin");
  if (!check.ok) return check.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  try {
    const store = getAerialStore();
    const was = await store.getSettings();
    const next = validateSettings(parsed.data);
    await store.saveSettings(next, check.user.id);
    const changes = [
      was.enabled !== next.enabled ? `turned ${next.enabled ? "on" : "off"}` : null,
      was.correctionBps !== next.correctionBps ? `correction factor ${was.correctionBps / 100}% to ${next.correctionBps / 100}%` : null,
      was.wasteBps !== next.wasteBps ? `waste ${was.wasteBps / 100}% to ${next.wasteBps / 100}%` : null,
    ].filter(Boolean);
    await recordAudit(check.user, {
      action: "settings.aerial_changed", entityType: "aerial_settings",
      summary: `Aerial estimates: ${changes.length ? changes.join(", ") : "edge lengths changed"}`, details: { from: was, to: next },
    });
    return Response.json({ settings: next });
  } catch (e) {
    if (e instanceof AerialError) return Response.json({ error: e.code, message: e.message }, { status: 400 });
    throw e;
  }
}
