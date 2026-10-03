import { depositDueCents, STAGES, type Division } from "../rules.ts";
import type { Actor, ProductionJob, TradeRow } from "./types.ts";

const isAdmin = (a: Actor) => a.role === "admin";
const ownsJob = (a: Actor, j: Pick<ProductionJob, "estimatorId">) => a.role === "estimator" && j.estimatorId === a.id;
const managesTrade = (a: Actor, division: Division, pm: readonly Division[]) => a.role === "production_manager" && pm.includes(division);

/** A signed contract and a covered deposit (or none required): the contract promises the deposit comes first. */
export function depositGateMet(j: Pick<ProductionJob, "contractSigned" | "depositRequiredCents" | "depositPaidCents">): boolean {
  return j.contractSigned && depositDueCents(j.depositRequiredCents, j.depositPaidCents) === 0;
}

export function isOpen(j: Pick<ProductionJob, "stage">): boolean {
  return j.stage !== "lost" && j.stage !== "cancelled_after_approval" && STAGES.includes(j.stage);
}

/** Job-level rights: who may see the job's production page, record the order, and enter colors. */
export function jobRights(a: Actor, j: ProductionJob, pm: readonly Division[]) {
  const staff = isAdmin(a) || ownsJob(a, j);
  const open = isOpen(j);
  const gate = depositGateMet(j);
  const ordered = j.materialsOrderedAt !== null;
  return {
    /** Estimator (own job) and admin see the whole job; a PM or crew leader sees only their own trades (see tradeRights). */
    canViewAll: staff,
    canOrderMaterials: staff && open && gate && !ordered,
    canEditSelections: staff && open && gate && !ordered,
  };
}

/** Per-trade rights. Gates (order recorded, deposit) are folded in so the screen only offers what will work. */
export function tradeRights(a: Actor, j: ProductionJob, t: Pick<TradeRow, "division" | "status" | "crewLeaderId">, pm: readonly Division[]) {
  const staff = isAdmin(a) || ownsJob(a, j);
  const pmOfTrade = managesTrade(a, t.division, pm);
  const assignedCrew = a.role === "crew_leader" && t.crewLeaderId === a.id && (t.status === "scheduled" || t.status === "in_production" || t.status === "complete");
  const open = isOpen(j);
  const ordered = j.materialsOrderedAt !== null;
  const gate = depositGateMet(j);
  const beforeStart = t.status === "not_scheduled" || t.status === "proposed" || t.status === "scheduled";
  const confirmer = isAdmin(a) || pmOfTrade;
  return {
    canView: staff || pmOfTrade || assignedCrew,
    // The estimator proposes a date until the PM has confirmed it; admin can always do it before the trade starts.
    canPropose: open && gate && ((staff && (t.status === "not_scheduled" || t.status === "proposed")) || (isAdmin(a) && beforeStart)),
    // The trade's PM (or admin) assigns the crew leader and confirms, once materials are ordered. Rescheduling is allowed until the trade starts.
    canConfirm: open && gate && ordered && confirmer && beforeStart,
    canStart: open && t.status === "scheduled" && (isAdmin(a) || pmOfTrade || assignedCrew),
    canComplete: open && t.status === "in_production" && (isAdmin(a) || pmOfTrade || assignedCrew),
  };
}
