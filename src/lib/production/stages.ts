import { STAGES, type Stage } from "../rules.ts";
import type { JobStageOrClosed, TradeStatus } from "./types.ts";

const started = (s: TradeStatus) => s === "in_production" || s === "complete";
const confirmed = (s: TradeStatus) => s === "scheduled" || started(s);

/**
 * Where a job's stage should be, given whether materials are ordered and the status of every trade on it.
 * Returns the new stage, or null for "no change". Stages only move forward.
 *  - materials ordered                      -> materials_ordered
 *  - every trade confirmed                  -> scheduled
 *  - any trade started                      -> in_production
 *  - every trade complete                   -> closeout_punchlist
 */
export function jobStageFromProduction(
  current: JobStageOrClosed, a: { materialsOrdered: boolean; trades: TradeStatus[] },
): Stage | null {
  if (current === "lost" || current === "cancelled_after_approval") return null;
  let target: Stage | null = null;
  if (a.trades.length > 0 && a.trades.every((s) => s === "complete")) target = "closeout_punchlist";
  else if (a.trades.some(started)) target = "in_production";
  else if (a.trades.length > 0 && a.trades.every(confirmed)) target = "scheduled";
  else if (a.materialsOrdered) target = "materials_ordered";
  if (!target) return null;
  return STAGES.indexOf(target) > STAGES.indexOf(current) ? target : null;
}
