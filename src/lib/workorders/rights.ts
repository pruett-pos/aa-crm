import type { Actor } from "../production/types.ts";
import type { Division } from "../rules.ts";
import type { WorkOrderJob, WorkOrderStatus, WorkOrderTrade } from "./types.ts";

const isAdmin = (a: Actor) => a.role === "admin";
const ownsJob = (a: Actor, j: Pick<WorkOrderJob, "estimatorId">) => a.role === "estimator" && j.estimatorId === a.id;
const started = (t: Pick<WorkOrderTrade, "status">) => t.status === "in_production" || t.status === "complete";

/** Admin and the job's own estimator create, edit and issue work orders. */
export const canManageWorkOrders = (a: Actor, j: Pick<WorkOrderJob, "estimatorId">) => isAdmin(a) || ownsJob(a, j);

/**
 * Who can see one trade's work order.
 *  - A draft: admin, the job's estimator, and the PM of that trade (so they can see what is coming).
 *  - An issued one: also the crew leader assigned to the trade, once the trade is confirmed.
 * A crew leader never sees a draft or another crew's trade.
 */
export function canViewWorkOrder(
  a: Actor, j: Pick<WorkOrderJob, "estimatorId">, status: WorkOrderStatus, trade: Pick<WorkOrderTrade, "division" | "status" | "crewLeaderId">, pm: readonly Division[],
): boolean {
  if (canManageWorkOrders(a, j)) return true;
  if (a.role === "production_manager") return pm.includes(trade.division);
  if (a.role === "crew_leader") {
    return status === "issued" && trade.crewLeaderId === a.id && (trade.status === "scheduled" || trade.status === "in_production" || trade.status === "complete");
  }
  return false;
}

/** An issued order can be reopened by admin, but only while the crew hasn't started the trade. */
export const canReopen = (a: Actor, trade: Pick<WorkOrderTrade, "status">) => isAdmin(a) && !started(trade);
