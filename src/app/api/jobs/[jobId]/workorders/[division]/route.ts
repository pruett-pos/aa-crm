import { z } from "zod";
import { requireRole } from "@/lib/auth/index.ts";
import { allow } from "@/lib/auth/rate-limit.ts";
import { getWorkOrderStore } from "@/lib/workorders/index.ts";
import { addTask, issueWorkOrder, removeTask, reopenWorkOrder, setTaskNote, setWorkOrderNotes } from "@/lib/workorders/logic.ts";
import { workOrderErrorResponse } from "@/lib/workorders/http.ts";

type Ctx = { params: Promise<{ jobId: string; division: string }> };

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("notes"), notes: z.string().max(2000).nullable() }),
  z.object({ action: z.literal("add_task"), description: z.string().max(400), quantity: z.union([z.number(), z.string().max(20)]), unit: z.string().max(20).nullable().optional(), note: z.string().max(600).nullable().optional() }),
  z.object({ action: z.literal("task_note"), lineId: z.string().max(64), note: z.string().max(600).nullable() }),
  z.object({ action: z.literal("remove_task"), lineId: z.string().max(64) }),
  z.object({ action: z.literal("issue") }),
  z.object({ action: z.literal("reopen") }),
]);

// Roles: admin and the job's estimator (the logic checks again, and reopening is admin only). A draft can be edited; issuing
// needs every color entered and freezes the task list.
export async function POST(req: Request, { params }: Ctx) {
  const check = await requireRole("admin", "estimator");
  if (!check.ok) return check.response;
  if (!allow(`wo:${check.user.id}`, 120, 15 * 60 * 1000)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { jobId, division } = await params;
  const actor = { id: check.user.id, role: check.user.role };
  const store = getWorkOrderStore();
  try {
    const b = parsed.data;
    if (b.action === "notes") await setWorkOrderNotes(store, actor, jobId, division, b.notes);
    else if (b.action === "add_task") await addTask(store, actor, jobId, division, { description: b.description, quantity: b.quantity, unit: b.unit, note: b.note });
    else if (b.action === "task_note") await setTaskNote(store, actor, jobId, division, b.lineId, b.note);
    else if (b.action === "remove_task") await removeTask(store, actor, jobId, division, b.lineId);
    else if (b.action === "issue") await issueWorkOrder(store, actor, jobId, division);
    else await reopenWorkOrder(store, actor, jobId, division);
    return Response.json({ ok: true });
  } catch (e) {
    return workOrderErrorResponse(e);
  }
}
