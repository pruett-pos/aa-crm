import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getHoverClient } from "@/lib/hover/index.ts";
import { getMeasurementStore } from "@/lib/measurements/index.ts";
import { importHoverMeasurements, measurementView, saveManualMeasurements, searchHover } from "@/lib/measurements/logic.ts";
import { measurementErrorResponse } from "@/lib/measurements/http.ts";

type Ctx = { params: Promise<{ jobId: string }> };

// A number, or the text a form sends for one. The server checks the range; this only keeps the shape sane.
const n = z.union([z.number(), z.string().max(20)]);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("search"), query: z.string().max(100).nullable().optional() }),
  z.object({ action: z.literal("import"), hoverJobId: z.string().min(1).max(40), modelId: z.string().min(1).max(40), query: z.string().max(100).nullable().optional() }),
  z.object({
    action: z.literal("manual"),
    note: z.string().max(300).nullable().optional(),
    values: z.object({
      roofAreaSqft: n,
      facets: n.nullable().optional(),
      pitches: z.array(z.object({ pitch: z.string().max(10), areaSqft: n, percent: n.nullable().optional() })).max(12).default([]),
      ridgesHipsFt: n.default(0), valleysFt: n.default(0), rakesFt: n.default(0), eavesFt: n.default(0), flashingFt: n.default(0), stepFlashingFt: n.default(0),
      sidingAreaSqft: n.nullable().optional(),
    }),
  }),
]);

// Roles: admin and the job's estimator can search Hover, import and type in measurements (until the contract is signed);
// a Production Manager with a trade on the job can view. The logic checks each person against the job.
export async function GET(_req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator", "production_manager");
  if (!check.ok) return check.response;
  const { jobId } = await params;
  try {
    return Response.json(await measurementView(getMeasurementStore(), { id: check.user.id, role: check.user.role }, jobId));
  } catch (e) {
    return measurementErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  if (!allow(`meas:${check.user.id}`, 60, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { jobId } = await params;
  const actor = { id: check.user.id, role: check.user.role };
  const store = getMeasurementStore();
  try {
    const b = parsed.data;
    if (b.action === "search") return Response.json({ candidates: await searchHover(store, getHoverClient(), actor, jobId, b.query) });
    if (b.action === "import") return Response.json(await importHoverMeasurements(store, getHoverClient(), actor, { jobId, hoverJobId: b.hoverJobId, modelId: b.modelId, query: b.query }), { status: 201 });
    const v = b.values;
    const toNum = (x: number | string | null | undefined) => (x === null || x === undefined || x === "" ? null : Number(x));
    const row = await saveManualMeasurements(store, actor, jobId, {
      roofAreaSqft: Number(v.roofAreaSqft), facets: toNum(v.facets),
      pitches: v.pitches.map((p) => ({ pitch: p.pitch, areaSqft: Number(p.areaSqft), percent: toNum(p.percent) })),
      ridgesHipsFt: Number(v.ridgesHipsFt), valleysFt: Number(v.valleysFt), rakesFt: Number(v.rakesFt), eavesFt: Number(v.eavesFt),
      flashingFt: Number(v.flashingFt), stepFlashingFt: Number(v.stepFlashingFt), sidingAreaSqft: toNum(v.sidingAreaSqft),
    }, b.note);
    return Response.json(row, { status: 201 });
  } catch (e) {
    return measurementErrorResponse(e);
  }
}
