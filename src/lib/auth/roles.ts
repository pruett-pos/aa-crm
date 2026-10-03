// Role-based access. Capabilities mirror SPEC section 1 (Users and roles).
// Components and routes ask `can(role, capability)`; they never compare role names directly.

export const ROLES = [
  "admin", "csr", "estimator", "production_manager", "crew_leader", "accounting",
] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = {
  manageUsers: ["admin"],
  manageCommissionSettings: ["admin"],
  createLeads: ["admin", "csr"],
  viewAllJobs: ["admin", "csr", "accounting"],
  buildScopes: ["admin", "estimator"],
  seeScopeMargin: ["admin", "estimator", "production_manager"], // never on the customer PDF
  seeOwnCommissions: ["estimator"],
  seeAllCommissions: ["admin", "accounting"],
  manageInvoicesAndPayments: ["admin", "accounting"],
  scheduleCrews: ["admin", "production_manager"],
  requestChangeOrders: ["crew_leader"],
} as const satisfies Record<string, readonly Role[]>;
export type Capability = keyof typeof CAPABILITIES;

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly Role[]).includes(role);
}

export function hasRole(role: Role, allowed: readonly Role[]): boolean {
  return allowed.includes(role);
}
