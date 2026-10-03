import type { Role } from "../auth/roles.ts";
import type { AuthUser } from "../auth/store.ts";
import type { Division } from "../rules.ts";
import type { JobFact } from "./types.ts";

export const REPORT_NAMES = [
  "close-rate", "sales", "cost-per-lead", "install-days", "ar-aging", "deposits", "depreciation", "commissions-owed",
] as const;
export type ReportName = (typeof REPORT_NAMES)[number];
export type Grouping = "estimator" | "division" | "source";

/**
 * Admin and accounting see everything. A PM sees sales, close rate and install timing for their divisions.
 * An estimator sees their own close rate and sales. A CSR sees lead and win counts by source, no dollars.
 */
export function reportsFor(role: Role): readonly ReportName[] {
  switch (role) {
    case "admin":
    case "accounting": return REPORT_NAMES;
    case "production_manager": return ["close-rate", "sales", "install-days"];
    case "estimator": return ["close-rate", "sales"];
    case "csr": return ["close-rate"];
    default: return [];
  }
}

export const canSeeReport = (role: Role, name: ReportName) => reportsFor(role).includes(name);

/** Groupings a role may ask for. A CSR gets source only, so no per-person numbers. */
export function groupingsFor(role: Role, name: ReportName): readonly Grouping[] {
  if (!canSeeReport(role, name)) return [];
  if (name === "close-rate") return role === "csr" ? ["source"] : ["estimator", "division", "source"];
  if (name === "sales") return ["division", "estimator"];
  return [];
}

/** Only the jobs this user may see: a PM's own divisions (by primary division), an estimator's own jobs. */
export function visibleFacts(user: Pick<AuthUser, "id" | "role">, facts: JobFact[], pmDivisions: readonly Division[]): JobFact[] {
  switch (user.role) {
    case "admin":
    case "accounting":
    case "csr": return facts;
    case "production_manager": return facts.filter((f) => f.divisions[0] !== undefined && pmDivisions.includes(f.divisions[0]));
    case "estimator": return facts.filter((f) => f.estimatorId === user.id);
    default: return [];
  }
}
