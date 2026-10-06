import { en } from "../../i18n/en.ts";
import type { Actor } from "../production/types.ts";
import type { Division } from "../rules.ts";
import { canManageWorkOrders, canReopen, canViewWorkOrder } from "./rights.ts";
import type { MaterialLine, NewLine, WorkOrder, WorkOrderJob, WorkOrderStore, WorkOrderTrade } from "./types.ts";

export type WorkOrderErrorCode =
  | "not_found" | "forbidden" | "no_signed_contract" | "closed" | "no_work_order" | "division_not_on_job" | "not_draft" | "not_issued"
  | "colors_missing" | "text_invalid" | "quantity_invalid" | "unit_invalid" | "too_many_lines" | "not_a_hand_line" | "line_not_found" | "trade_started";

export class WorkOrderError extends Error {
  code: WorkOrderErrorCode;
  /** For colors_missing: how many lines still need a color. */
  count: number | null;
  constructor(code: WorkOrderErrorCode, message?: string, count: number | null = null) {
    super(message ?? code);
    this.code = code;
    this.count = count;
  }
}

const MAX_LINES = 60;
const tradeName = (d: string) => (en.leads.divisionNames as Record<string, string>)[d] ?? d;
const isClosed = (j: Pick<WorkOrderJob, "stage">) => j.stage === "lost" || j.stage === "cancelled_after_approval";

const cleanText = (s: unknown, max: number, field: "note" | "task"): string => {
  const t = typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (field === "task" && (t.length < 1 || t.length > max)) throw new WorkOrderError("text_invalid");
  if (t.length > max) throw new WorkOrderError("text_invalid");
  return t;
};
const cleanNote = (s: unknown, max: number): string | null => (s === undefined || s === null || s === "" ? null : cleanText(s, max, "note") || null);

// ---------- Making the drafts ----------
/**
 * Make a draft work order for each trade on the job that has a chosen package and none yet, copying the package's labor and
 * other lines (quantities and units only). Safe to call again: trades that already have one are left alone.
 * `actorId` is null when the system does it at signing.
 */
export async function createWorkOrders(store: WorkOrderStore, jobId: string, actorId: string | null): Promise<{ created: Division[] }> {
  return store.transaction(jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new WorkOrderError("not_found");
    if (isClosed(job)) throw new WorkOrderError("closed");
    if (!job.contractSigned) throw new WorkOrderError("no_signed_contract");
    const have = new Set((await tx.listOrders()).map((o) => o.division));
    const created: Division[] = [];
    for (const division of job.divisions) {
      if (have.has(division)) continue;
      const source = await tx.sourceLines(division);
      if (source.length === 0) continue;                             // no chosen package, or no labor lines on it
      await tx.insertOrder(division, source.slice(0, MAX_LINES).map((s): NewLine => ({ sourceItemId: s.itemId, description: s.description, quantity: s.quantity, unit: s.unit, note: null })), actorId);
      created.push(division);
    }
    return { created };
  });
}

/** The estimator or admin asks for the drafts (the "Create work order" button): same as above, with a permission check. */
export async function createWorkOrdersFor(store: WorkOrderStore, actor: Actor, jobId: string): Promise<{ created: Division[] }> {
  const job = await store.getJob(jobId);
  if (!job) throw new WorkOrderError("not_found");
  if (!canManageWorkOrders(actor, job)) throw new WorkOrderError("forbidden");
  return createWorkOrders(store, jobId, actor.id);
}

export type SigningMailer = (a: { to: string; estimatorName: string; jobNumber: number; address: string; missing: number }) => Promise<void>;

/**
 * Called after a contract is signed. Makes the draft work orders and tells the job's estimator it is time to enter colors.
 * NEVER THROWS: the signature stands whatever happens here, and a failure just leaves "Create work order" and the jobs list's
 * "Colors needed" to cover it.
 */
export async function onContractSigned(store: WorkOrderStore, mail: SigningMailer, jobId: string): Promise<{ created: Division[]; emailed: boolean }> {
  let created: Division[] = [];
  let emailed = false;
  try {
    created = (await createWorkOrders(store, jobId, null)).created;
  } catch {
    /* recorded nowhere else on purpose: the estimator's button and the colors queue still work */
  }
  try {
    const [who, job, needing] = await Promise.all([store.estimatorContact(jobId), store.getJob(jobId), store.jobsNeedingColors()]);
    if (who && job) {
      await mail({ to: who.email, estimatorName: who.name, jobNumber: job.jobNumber, address: job.address, missing: needing.find((n) => n.jobId === jobId)?.missing ?? 0 });
      emailed = true;
    }
  } catch {
    emailed = false;
  }
  return { created, emailed };
}

// ---------- The view ----------
export type LineView = { id: string; description: string; quantity: number; unit: string; note: string | null; handAdded: boolean };
export type WorkOrderView = {
  division: Division;
  status: "draft" | "issued";
  notes: string | null;
  issuedAt: string | null;
  installDate: string | null;
  crewLeaderName: string | null;
  lines: LineView[];
  canEdit: boolean;
  canIssue: boolean;
  /** Why it can't be issued yet: how many material lines still need a color. */
  colorsMissing: number;
  canReopen: boolean;
  tradeStarted: boolean;
};
export type WorkOrdersOverview = { job: { id: string; jobNumber: number; address: string }; orders: WorkOrderView[]; canCreate: boolean; missingTrades: Division[] };

const toView = (o: WorkOrder, t: WorkOrderTrade, edit: boolean, missing: number, reopen: boolean): WorkOrderView => ({
  division: o.division, status: o.status, notes: o.notes, issuedAt: o.issuedAt ? o.issuedAt.toISOString() : null, installDate: t.installDate, crewLeaderName: t.crewLeaderName,
  lines: o.lines.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity, unit: l.unit, note: l.note, handAdded: l.sourceItemId === null })),
  canEdit: edit && o.status === "draft", canIssue: edit && o.status === "draft" && missing === 0 && o.lines.length > 0, colorsMissing: edit ? missing : 0,
  canReopen: reopen && o.status === "issued", tradeStarted: t.status === "in_production" || t.status === "complete",
});

/** What this person may see of the job's work orders. A crew leader gets issued orders for their own trade only. */
export async function workOrdersView(store: WorkOrderStore, actor: Actor, jobId: string): Promise<WorkOrdersOverview> {
  const job = await store.getJob(jobId);
  if (!job) throw new WorkOrderError("not_found");
  const [trades, pm, orders] = await Promise.all([store.listTrades(jobId), store.pmDivisions(actor.id), store.listOrders(jobId)]);
  const tradeOf = (d: Division): WorkOrderTrade => trades.find((t) => t.division === d) ?? { division: d, status: "not_scheduled", installDate: null, crewLeaderId: null, crewLeaderName: null };
  const manage = canManageWorkOrders(actor, job);
  const visible = orders.filter((o) => canViewWorkOrder(actor, job, o.status, tradeOf(o.division), pm));
  if (visible.length === 0 && !manage && !(actor.role === "production_manager" && job.divisions.some((d) => pm.includes(d)))) throw new WorkOrderError("forbidden");

  const out: WorkOrderView[] = [];
  for (const o of visible) {
    const missing = manage && o.status === "draft" ? await store.colorsMissing(jobId, o.division) : 0;
    out.push(toView(o, tradeOf(o.division), manage, missing, canReopen(actor, tradeOf(o.division))));
  }
  const have = new Set(orders.map((o) => o.division));
  return {
    job: { id: job.id, jobNumber: job.jobNumber, address: job.address },
    orders: out.sort((a, b) => job.divisions.indexOf(a.division) - job.divisions.indexOf(b.division)),
    canCreate: manage && job.contractSigned && !isClosed(job) && job.divisions.some((d) => !have.has(d)),
    missingTrades: manage ? job.divisions.filter((d) => !have.has(d)) : [],
  };
}

// ---------- Editing a draft ----------
async function editDraft<T>(store: WorkOrderStore, actor: Actor, jobId: string, division: string, fn: (tx: Parameters<Parameters<WorkOrderStore["transaction"]>[1]>[0], order: WorkOrder) => Promise<T>): Promise<T> {
  return store.transaction(jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new WorkOrderError("not_found");
    if (!canManageWorkOrders(actor, job)) throw new WorkOrderError("forbidden");
    if (!(job.divisions as string[]).includes(division)) throw new WorkOrderError("division_not_on_job");
    if (isClosed(job)) throw new WorkOrderError("closed");
    const order = (await tx.listOrders()).find((o) => o.division === division);
    if (!order) throw new WorkOrderError("no_work_order");
    if (order.status !== "draft") throw new WorkOrderError("not_draft");
    return fn(tx, order);
  });
}

export const setWorkOrderNotes = (store: WorkOrderStore, actor: Actor, jobId: string, division: string, notes: unknown) =>
  editDraft(store, actor, jobId, division, (tx, o) => tx.setNotes(o.id, cleanNote(notes, 1000)));

export async function addTask(store: WorkOrderStore, actor: Actor, jobId: string, division: string, a: { description: unknown; quantity: unknown; unit?: unknown; note?: unknown }): Promise<void> {
  const description = cleanText(a.description, 200, "task");
  const q = typeof a.quantity === "number" ? a.quantity : typeof a.quantity === "string" && a.quantity.trim() !== "" ? Number(a.quantity) : NaN;
  if (!Number.isFinite(q) || q <= 0 || q > 100_000) throw new WorkOrderError("quantity_invalid");
  const unit = typeof a.unit === "string" && a.unit.trim() !== "" ? a.unit.trim().toLowerCase() : "ea";
  if (!/^[a-z]{1,8}$/.test(unit)) throw new WorkOrderError("unit_invalid");
  const note = cleanNote(a.note, 300);
  await editDraft(store, actor, jobId, division, async (tx, o) => {
    if (o.lines.length >= MAX_LINES) throw new WorkOrderError("too_many_lines");
    await tx.addLine(o.id, { sourceItemId: null, description, quantity: Math.round(q * 100) / 100, unit, note });
  });
}

export async function setTaskNote(store: WorkOrderStore, actor: Actor, jobId: string, division: string, lineId: string, note: unknown): Promise<void> {
  const clean = cleanNote(note, 300);
  await editDraft(store, actor, jobId, division, async (tx, o) => {
    if (!(await tx.setLineNote(o.id, lineId, clean))) throw new WorkOrderError("line_not_found");
  });
}

export const removeTask = (store: WorkOrderStore, actor: Actor, jobId: string, division: string, lineId: string) =>
  editDraft(store, actor, jobId, division, async (tx, o) => {
    const line = o.lines.find((l) => l.id === lineId);
    if (!line) throw new WorkOrderError("line_not_found");
    if (line.sourceItemId !== null) throw new WorkOrderError("not_a_hand_line", "Lines from the signed scope can't be removed");
    if (!(await tx.removeHandLine(o.id, lineId))) throw new WorkOrderError("line_not_found");
  });

// ---------- Issue and reopen ----------
/** Freeze the task list and release it to the PM and, once the trade is confirmed, the crew. Needs every color entered. */
export function issueWorkOrder(store: WorkOrderStore, actor: Actor, jobId: string, division: string, now: () => Date = () => new Date()) {
  return editDraft(store, actor, jobId, division, async (tx, o) => {
    const missing = await tx.colorsMissing(o.division);
    if (missing > 0) throw new WorkOrderError("colors_missing", `${missing} material lines still need a color`, missing);
    if (o.lines.length === 0) throw new WorkOrderError("no_work_order", "There are no tasks on this work order");
    await tx.setStatus(o.id, "issued", actor.id, now());
  });
}

/** Admin only, and only while the crew hasn't started the trade: back to a draft so it can be corrected. */
export async function reopenWorkOrder(store: WorkOrderStore, actor: Actor, jobId: string, division: string): Promise<void> {
  const trades = await store.listTrades(jobId);
  await store.transaction(jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new WorkOrderError("not_found");
    if (!canManageWorkOrders(actor, job) || actor.role !== "admin") throw new WorkOrderError("forbidden");
    if (!(job.divisions as string[]).includes(division)) throw new WorkOrderError("division_not_on_job");
    const order = (await tx.listOrders()).find((o) => o.division === division);
    if (!order) throw new WorkOrderError("no_work_order");
    if (order.status !== "issued") throw new WorkOrderError("not_issued");
    const trade = trades.find((t) => t.division === division);
    if (trade && !canReopen(actor, trade)) throw new WorkOrderError("trade_started", "The crew has already started this trade");
    await tx.setStatus(order.id, "draft", null, new Date());
  });
}

// ---------- PDF ----------
export type WorkOrderPdfData = {
  jobNumber: number; tradeLabel: string; address: string; status: "draft" | "issued"; issuedOn: string | null;
  installDate: string | null; crewLeaderName: string | null; notes: string | null;
  tasks: { description: string; quantity: number; unit: string; note: string | null }[];
  materials: MaterialLine[];
};

/** The data for a work order's PDF, for whoever may see it. Customer name and phone are never included. */
export async function workOrderPdfData(store: WorkOrderStore, actor: Actor, jobId: string, division: string): Promise<WorkOrderPdfData> {
  const job = await store.getJob(jobId);
  if (!job) throw new WorkOrderError("not_found");
  if (!(job.divisions as string[]).includes(division)) throw new WorkOrderError("not_found");
  const [trades, pm, orders] = await Promise.all([store.listTrades(jobId), store.pmDivisions(actor.id), store.listOrders(jobId)]);
  const order = orders.find((o) => o.division === division);
  const trade = trades.find((t) => t.division === division) ?? { division: division as Division, status: "not_scheduled" as const, installDate: null, crewLeaderId: null, crewLeaderName: null };
  // Not even confirmed to exist to someone who may not see it.
  if (!order || !canViewWorkOrder(actor, job, order.status, trade, pm)) throw new WorkOrderError("not_found");
  return {
    jobNumber: job.jobNumber, tradeLabel: tradeName(division), address: job.address, status: order.status, issuedOn: order.issuedAt ? order.issuedAt.toISOString().slice(0, 10) : null,
    installDate: trade.installDate, crewLeaderName: trade.crewLeaderName, notes: order.notes,
    tasks: order.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit, note: l.note })),
    materials: await store.materials(jobId, division as Division),
  };
}
