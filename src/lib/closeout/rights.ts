import type { Actor } from "../production/types.ts";
import type { Division } from "../rules.ts";
import type { CloseoutJob, CloseoutTrade } from "./types.ts";

const isAdmin = (a: Actor) => a.role === "admin";
const ownsJob = (a: Actor, j: Pick<CloseoutJob, "estimatorId">) => a.role === "estimator" && j.estimatorId === a.id;
/** A crew leader counts as assigned to a trade once it is confirmed. */
const crewOnTrade = (a: Actor, t: CloseoutTrade) =>
  a.role === "crew_leader" && t.crewLeaderId === a.id && (t.status === "scheduled" || t.status === "in_production" || t.status === "complete");

/**
 * Who can do what on a job's closeout punchlist.
 *  - Admin and the job's own estimator: everything.
 *  - A Production Manager: the items of the trades they manage, plus the whole-job items.
 *  - An assigned crew leader: see and tick the items of their trade and the whole-job items. Cannot add, rename or remove.
 */
export function punchRights(a: Actor, job: Pick<CloseoutJob, "estimatorId">, trades: CloseoutTrade[], pm: readonly Division[]) {
  const staff = isAdmin(a) || ownsJob(a, job);
  const pmTrades = a.role === "production_manager" ? trades.filter((t) => pm.includes(t.division)).map((t) => t.division) : [];
  const crewTrades = trades.filter((t) => crewOnTrade(a, t)).map((t) => t.division);
  const involved = staff || pmTrades.length > 0 || crewTrades.length > 0;
  const readOnlyAll = a.role === "accounting";   // accounting sees the whole list (why an invoice is blocked) but changes nothing
  const canTick = (division: Division | null) =>
      staff || (division === null ? pmTrades.length > 0 || crewTrades.length > 0 : pmTrades.includes(division) || crewTrades.includes(division));
  return {
    /** Sees the closeout screen at all. */
    canView: involved || readOnlyAll,
    /** Sees this item. */
    canSee: (division: Division | null) => readOnlyAll || canTick(division),
    /** May tick this item. */
    canTick,
    /** Starts the list, adds, renames and removes items. */
    canManage: (division: Division | null) =>
      staff || (division === null ? pmTrades.length > 0 : pmTrades.includes(division)),
    canStart: staff || pmTrades.length > 0,
  };
}

/** Invoices: admin and accounting issue, send and void; the job's estimator and a PM with a trade on it can view. */
export const canManageInvoice = (a: Actor) => a.role === "admin" || a.role === "accounting";
export function canViewInvoice(a: Actor, job: Pick<CloseoutJob, "estimatorId">, trades: CloseoutTrade[], pm: readonly Division[]): boolean {
  if (canManageInvoice(a) || ownsJob(a, job)) return true;
  return a.role === "production_manager" && trades.some((t) => pm.includes(t.division));
}
