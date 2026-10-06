import { localDate } from "../commission/periods.ts";
import type { Division } from "../rules.ts";
import { DIVISIONS } from "../leads/types.ts";
import { checkInstallDate } from "./dates.ts";
import { buildMaterialList, type MaterialList } from "./materials.ts";
import { depositGateMet, isOpen, jobRights, tradeRights } from "./rights.ts";
import { jobStageFromProduction } from "./stages.ts";
import type { Actor, ProductionJob, ProductionStore, ProductionTx, ScheduleItem, TradeRow } from "./types.ts";

export type ProductionErrorCode =
  | "not_found" | "forbidden" | "closed" | "no_signed_contract" | "deposit_not_covered" | "materials_not_ordered"
  | "bad_status" | "date_required" | "date_invalid" | "date_in_past" | "date_too_far" | "crew_invalid" | "crew_required"
  | "already_ordered" | "po_required" | "selections_locked" | "selection_invalid" | "division_not_on_job" | "invalid_range";

export class ProductionError extends Error {
  code: ProductionErrorCode;
  constructor(code: ProductionErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

const EMPTY_TRADE = (division: Division): TradeRow => ({
  division, status: "not_scheduled", installDate: null, crewLeaderId: null, crewLeaderName: null,
  proposedBy: null, confirmedBy: null, startedAt: null, completedAt: null, notes: null,
});

/** One row per trade on the job; a trade with no row yet is "not scheduled". */
export function mergeTrades(divisions: readonly Division[], rows: TradeRow[]): TradeRow[] {
  return divisions.map((d) => rows.find((r) => r.division === d) ?? EMPTY_TRADE(d));
}

async function pmDivisionsFor(store: ProductionStore, actor: Actor): Promise<Division[]> {
  return actor.role === "production_manager" ? store.pmDivisions(actor.id) : [];
}

function requireOpenGated(job: ProductionJob) {
  if (!isOpen(job)) throw new ProductionError("closed", "This job is closed");
  if (!job.contractSigned) throw new ProductionError("no_signed_contract", "The contract isn't signed yet");
  if (!depositGateMet(job)) throw new ProductionError("deposit_not_covered", "The deposit isn't covered yet");
}

/** Colors can be entered once the contract is signed; the deposit only gates ordering and scheduling. */
function requireOpenSigned(job: ProductionJob) {
  if (!isOpen(job)) throw new ProductionError("closed", "This job is closed");
  if (!job.contractSigned) throw new ProductionError("no_signed_contract", "The contract isn't signed yet");
}

function dateProblem(date: string, today: string): never | void {
  const p = checkInstallDate(date, today);
  if (p === "invalid") throw new ProductionError("date_invalid", "Enter a real date");
  if (p === "in_the_past") throw new ProductionError("date_in_past", "The install date can't be in the past");
  if (p === "too_far_ahead") throw new ProductionError("date_too_far", "The install date is more than a year away");
}

/** After any change: keep the job's install date at its earliest trade date and move its stage forward if the trades call for it. */
async function syncJob(tx: ProductionTx, job: ProductionJob, actorId: string): Promise<void> {
  const trades = mergeTrades(job.divisions, await tx.listTrades());
  const dates = trades.map((t) => t.installDate).filter((d): d is string => d !== null).sort();
  await tx.setJobInstallDate(dates[0] ?? null);
  const fresh = (await tx.getJob()) ?? job;
  const next = jobStageFromProduction(fresh.stage, { materialsOrdered: fresh.materialsOrderedAt !== null, trades: trades.map((t) => t.status) });
  if (next) await tx.setStage(fresh.stage, next, actorId);
}

function tradeOrThrow(job: ProductionJob, division: string): Division {
  if (!(DIVISIONS as readonly string[]).includes(division) || !job.divisions.includes(division as Division)) {
    throw new ProductionError("division_not_on_job", "That trade isn't on this job");
  }
  return division as Division;
}

// ---------- Propose a date (estimator or admin) ----------
export async function proposeInstall(
  store: ProductionStore, a: { actor: Actor; jobId: string; division: string; installDate: string }, now: () => Date = () => new Date(),
): Promise<TradeRow> {
  const pm = await pmDivisionsFor(store, a.actor);
  return store.transaction(a.jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new ProductionError("not_found");
    const division = tradeOrThrow(job, a.division);
    const trade = mergeTrades(job.divisions, await tx.listTrades()).find((t) => t.division === division)!;
    const r = tradeRights(a.actor, job, trade, pm);
    if (!jobRights(a.actor, job, pm).canViewAll) throw new ProductionError("forbidden");
    requireOpenGated(job);
    dateProblem(a.installDate, localDate(now()));
    if (!r.canPropose) throw new ProductionError("bad_status", "The date can't be proposed in this state");
    // A date change on an already confirmed trade (admin) keeps it confirmed with its crew.
    await tx.upsertTrade(division, { status: trade.status === "scheduled" ? "scheduled" : "proposed", installDate: a.installDate, proposedBy: a.actor.id });
    await tx.logEvent({ division, actorId: a.actor.id, action: "propose", detail: a.installDate });
    await syncJob(tx, job, a.actor.id);
    return mergeTrades(job.divisions, await tx.listTrades()).find((t) => t.division === division)!;
  });
}

// ---------- Confirm: assign the crew leader (the trade's PM or admin) ----------
export async function confirmInstall(
  store: ProductionStore, a: { actor: Actor; jobId: string; division: string; installDate?: string | null; crewLeaderId: string | null },
  now: () => Date = () => new Date(),
): Promise<{ trade: TradeRow; conflicts: { jobNumber: number; division: Division }[] }> {
  const pm = await pmDivisionsFor(store, a.actor);
  const crewOk = a.crewLeaderId ? await store.isActiveCrewLeader(a.crewLeaderId) : false;
  return store.transaction(a.jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new ProductionError("not_found");
    const division = tradeOrThrow(job, a.division);
    const trade = mergeTrades(job.divisions, await tx.listTrades()).find((t) => t.division === division)!;
    const isConfirmer = a.actor.role === "admin" || (a.actor.role === "production_manager" && pm.includes(division));
    if (!isConfirmer) throw new ProductionError("forbidden");
    requireOpenGated(job);
    if (!job.materialsOrderedAt) throw new ProductionError("materials_not_ordered", "Record the materials order first");
    if (!tradeRights(a.actor, job, trade, pm).canConfirm) throw new ProductionError("bad_status", "This trade has already started");
    const date = a.installDate ?? trade.installDate;
    if (!date) throw new ProductionError("date_required", "Choose an install date");
    dateProblem(date, localDate(now()));
    if (!a.crewLeaderId) throw new ProductionError("crew_required", "Choose a crew leader");
    if (!crewOk) throw new ProductionError("crew_invalid", "That person isn't an active crew leader");

    const conflicts = await tx.crewConflicts(a.crewLeaderId, date, { jobId: job.id, division });
    await tx.upsertTrade(division, { status: "scheduled", installDate: date, crewLeaderId: a.crewLeaderId, confirmedBy: a.actor.id });
    await tx.logEvent({ division, actorId: a.actor.id, action: "confirm", detail: `${date} crew ${a.crewLeaderId}` });
    await syncJob(tx, job, a.actor.id);
    return { trade: mergeTrades(job.divisions, await tx.listTrades()).find((t) => t.division === division)!, conflicts };
  });
}

// ---------- Start and complete (assigned crew leader, the trade's PM, or admin) ----------
async function moveTrade(
  store: ProductionStore, a: { actor: Actor; jobId: string; division: string }, kind: "start" | "complete", now: () => Date,
): Promise<TradeRow> {
  const pm = await pmDivisionsFor(store, a.actor);
  return store.transaction(a.jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new ProductionError("not_found");
    const division = tradeOrThrow(job, a.division);
    const trade = mergeTrades(job.divisions, await tx.listTrades()).find((t) => t.division === division)!;
    const r = tradeRights(a.actor, job, trade, pm);
    const involved = a.actor.role === "admin" || (a.actor.role === "production_manager" && pm.includes(division)) || trade.crewLeaderId === a.actor.id;
    if (!involved) throw new ProductionError("forbidden");
    if (!isOpen(job)) throw new ProductionError("closed");
    if (!(kind === "start" ? r.canStart : r.canComplete)) throw new ProductionError("bad_status", kind === "start" ? "Only a scheduled trade can be started" : "Only a trade in production can be completed");
    const at = now();
    await tx.upsertTrade(division, kind === "start" ? { status: "in_production", startedAt: at } : { status: "complete", completedAt: at });
    await tx.logEvent({ division, actorId: a.actor.id, action: kind });
    await syncJob(tx, job, a.actor.id);
    return mergeTrades(job.divisions, await tx.listTrades()).find((t) => t.division === division)!;
  });
}
export const startTrade = (store: ProductionStore, a: { actor: Actor; jobId: string; division: string }, now: () => Date = () => new Date()) => moveTrade(store, a, "start", now);
export const completeTrade = (store: ProductionStore, a: { actor: Actor; jobId: string; division: string }, now: () => Date = () => new Date()) => moveTrade(store, a, "complete", now);

// ---------- Materials order and colors (estimator or admin) ----------
export async function recordMaterialsOrder(
  store: ProductionStore, a: { actor: Actor; jobId: string; poReference: string; notes?: string | null }, now: () => Date = () => new Date(),
): Promise<void> {
  const pm = await pmDivisionsFor(store, a.actor);
  const po = a.poReference.trim();
  await store.transaction(a.jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new ProductionError("not_found");
    if (!jobRights(a.actor, job, pm).canViewAll) throw new ProductionError("forbidden");
    requireOpenGated(job);
    if (job.materialsOrderedAt) throw new ProductionError("already_ordered", "Materials were already ordered for this job");
    if (po.length < 1 || po.length > 60) throw new ProductionError("po_required", "Enter the purchase order number");
    await tx.setMaterialsOrder(now(), a.actor.id, po, a.notes?.trim().slice(0, 300) || null);
    await tx.logEvent({ division: null, actorId: a.actor.id, action: "materials_ordered", detail: po });
    await syncJob(tx, job, a.actor.id);
  });
}

export async function saveSelections(
  store: ProductionStore, a: { actor: Actor; jobId: string; items: { itemId: string; color: string | null }[] },
): Promise<void> {
  const pm = await pmDivisionsFor(store, a.actor);
  await store.transaction(a.jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new ProductionError("not_found");
    if (!jobRights(a.actor, job, pm).canViewAll) throw new ProductionError("forbidden");
    requireOpenSigned(job);
    if (job.materialsOrderedAt) throw new ProductionError("selections_locked", "Materials are already ordered, so colors are locked");
    const valid = await tx.chosenMaterialItemIds();
    const cleaned = a.items.map((i) => {
      if (!valid.has(i.itemId)) throw new ProductionError("selection_invalid", "That line isn't part of a chosen package");
      const color = i.color?.trim() || null;
      if (color && color.length > 60) throw new ProductionError("selection_invalid", "A color name is too long");
      return { itemId: i.itemId, color };
    });
    await tx.setColors(cleaned);
    await tx.logEvent({ division: null, actorId: a.actor.id, action: "selections", detail: `${cleaned.length} lines` });
  });
}

// ---------- What each person sees ----------
export type TradeView = {
  division: Division; status: TradeRow["status"]; installDate: string | null; crewLeaderName: string | null; crewLeaderId: string | null;
  rights: ReturnType<typeof tradeRights>;
};
export type ProductionView = {
  job: {
    id: string; jobNumber: number; stage: string; propertyAddress: string; customerName: string | null;
    materialsOrdered: { at: string; poReference: string | null } | null; depositGateMet: boolean; contractSigned: boolean;
  };
  rights: ReturnType<typeof jobRights>;
  trades: TradeView[];
  crewLeaders: { id: string; fullName: string }[];
  materials: MaterialList | null;
  /** The material lines of the chosen packages, for entering colors (estimator and admin only). */
  selectionLines: { itemId: string; division: Division; description: string; unit: string; quantity: number; color: string | null }[];
};

async function selectionLinesFor(store: ProductionStore, chosen: Awaited<ReturnType<ProductionStore["getChosenScopes"]>>) {
  const unit = new Map((await store.listProducts()).map((p) => [p.id, p.unit]));
  return chosen.flatMap((s) => s.items.flatMap((i, idx) =>
    i.kind === "material" ? [{
      itemId: i.id ?? `${s.id}:${idx}`, division: s.division, description: i.description,
      unit: (i.productId && unit.get(i.productId)) || "ea", quantity: i.quantity, color: i.color,
    }] : []));
}

export async function productionView(store: ProductionStore, actor: Actor, jobId: string): Promise<ProductionView> {
  const job = await store.getJob(jobId);
  if (!job) throw new ProductionError("not_found");
  const pm = await pmDivisionsFor(store, actor);
  const trades = mergeTrades(job.divisions, await store.listTrades(jobId));
  const visible = trades.filter((t) => tradeRights(actor, job, t, pm).canView);
  if (visible.length === 0) throw new ProductionError("forbidden");
  const rights = jobRights(actor, job, pm);

  // Materials: everything for staff, only your own trades for a PM or crew leader. Never any prices.
  const chosen = await store.getChosenScopes(jobId);
  const materials = job.contractSigned
    ? buildMaterialList(chosen, await store.listProducts(), rights.canViewAll ? undefined : visible.map((t) => t.division))
    : null;
  const canConfirmAny = visible.some((t) => tradeRights(actor, job, t, pm).canConfirm);
  return {
    job: {
      id: job.id, jobNumber: job.jobNumber, stage: job.stage, propertyAddress: job.propertyAddress,
      customerName: actor.role === "crew_leader" ? null : job.customerName,       // crew leaders get the address only
      materialsOrdered: job.materialsOrderedAt ? { at: job.materialsOrderedAt.toISOString(), poReference: job.poReference } : null,
      depositGateMet: depositGateMet(job), contractSigned: job.contractSigned,
    },
    rights,
    trades: visible.map((t) => ({
      division: t.division, status: t.status, installDate: t.installDate, crewLeaderName: t.crewLeaderName, crewLeaderId: t.crewLeaderId,
      rights: tradeRights(actor, job, t, pm),
    })),
    selectionLines: rights.canViewAll && job.contractSigned ? await selectionLinesFor(store, chosen) : [],
    crewLeaders: canConfirmAny ? await store.listCrewLeaders() : [],
    materials,
  };
}

// ---------- The schedule board ----------
export type BoardFilters = { division?: string | null; crewLeaderId?: string | null };
export type BoardItem = Omit<ScheduleItem, "customerName" | "estimatorId"> & { customerName: string | null };
export type Board = { items: BoardItem[]; needsDate: BoardItem[]; needsCrew: BoardItem[] };

export async function scheduleBoard(
  store: ProductionStore, actor: Actor, range: { from: string; to: string }, filters: BoardFilters = {},
): Promise<Board> {
  if (!["admin", "estimator", "production_manager", "crew_leader"].includes(actor.role)) throw new ProductionError("forbidden");
  const pm = await pmDivisionsFor(store, actor);
  const mine = (i: ScheduleItem) =>
    actor.role === "admin" ? true
    : actor.role === "estimator" ? i.estimatorId === actor.id
    : actor.role === "production_manager" ? pm.includes(i.division)
    : i.crewLeaderId === actor.id && (i.status === "scheduled" || i.status === "in_production" || i.status === "complete");
  const passes = (i: ScheduleItem) =>
    mine(i) && (!filters.division || i.division === filters.division) && (!filters.crewLeaderId || i.crewLeaderId === filters.crewLeaderId);
  const shape = (i: ScheduleItem): BoardItem => {
    const { estimatorId: _e, customerName, ...rest } = i;
    return { ...rest, customerName: actor.role === "crew_leader" ? null : customerName };
  };
  const items = (await store.listSchedule(range)).filter(passes).map(shape);
  if (actor.role === "crew_leader") return { items, needsDate: [], needsCrew: [] };
  const open = (await store.listOpenTrades()).filter(passes);
  return {
    items,
    needsDate: open.filter((i) => i.status === "not_scheduled").map(shape),   // waiting for the estimator's date
    needsCrew: open.filter((i) => i.status === "proposed" || i.status === "not_scheduled").map(shape), // waiting for a PM to confirm
  };
}

export type { ScheduleItem };
