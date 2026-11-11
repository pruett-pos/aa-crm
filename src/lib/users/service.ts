// User management (Settings -> Users). Admin only: every function checks the actor again, on top of the route's role check.
import { normalizeEmail } from "../auth/core.ts";
import { ROLES, can, type Role } from "../auth/roles.ts";
import type { AuthUser } from "../auth/store.ts";
import type { AuditEntry } from "../audit/index.ts";
import type { Division } from "../rules.ts";
import type { Market } from "../leads/routing.ts";
import { DIVISIONS, MARKETS } from "../leads/types.ts";
import type { AdminUser, NewUserData, UserAdminStore, UserPatch } from "./types.ts";

export type UserErrorCode =
  | "forbidden" | "not_found" | "invalid_name" | "invalid_email" | "invalid_phone" | "invalid_role" | "invalid_market"
  | "invalid_division" | "market_required" | "duplicate_email" | "division_taken" | "cannot_change_own_role"
  | "cannot_deactivate_self" | "cannot_change_own_email" | "not_a_manager" | "not_an_estimator";

export class UserError extends Error {
  code: UserErrorCode;
  constructor(code: UserErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin", csr: "CSR", estimator: "Estimator", production_manager: "Production Manager", crew_leader: "Crew leader", accounting: "Accounting",
};

const guard = (actor: AuthUser) => {
  if (!actor.active || !can(actor.role, "manageUsers")) throw new UserError("forbidden");
};

export function cleanName(raw: string): string {
  const n = raw.replace(/\s+/g, " ").trim();
  if (n.length < 2 || n.length > 100) throw new UserError("invalid_name", "Enter the person's full name (2 to 100 characters)");
  return n;
}

export function cleanEmail(raw: string): string {
  const e = normalizeEmail(raw);
  if (e.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new UserError("invalid_email", "Enter a valid email address");
  return e;
}

/** Blank is allowed. Otherwise a US number: 10 digits (a leading 1 is dropped). Stored as (417) 555-0123. */
export function cleanPhone(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  let d = t.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) throw new UserError("invalid_phone", "Enter a 10-digit phone number");
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

const cleanRole = (r: string): Role => {
  if (!(ROLES as readonly string[]).includes(r)) throw new UserError("invalid_role");
  return r as Role;
};
const cleanMarket = (m: string | null | undefined): Market | null => {
  if (m == null || m === "") return null;
  if (!(MARKETS as readonly string[]).includes(m)) throw new UserError("invalid_market");
  return m as Market;
};
function cleanDivisions(list: readonly string[] | undefined): Division[] {
  const out: Division[] = [];
  for (const d of list ?? []) {
    if (!(DIVISIONS as readonly string[]).includes(d)) throw new UserError("invalid_division");
    if (!out.includes(d as Division)) out.push(d as Division);
  }
  return out;
}

async function assertDivisionsFree(store: UserAdminStore, market: Market, divisions: Division[], exceptUserId?: string) {
  const held = await store.divisionHolders(market, divisions, exceptUserId);
  if (held.length) {
    const h = held[0];
    throw new UserError("division_taken", `${h.fullName} already manages ${h.division.replace("_", " / ")} in this market. Change that person first.`);
  }
}

const who = (u: { fullName: string; email: string }) => `${u.fullName} (${u.email})`;

export type NewUserInput = { fullName: string; email: string; phone?: string | null; role: string; market?: string | null; divisions?: string[]; active?: boolean; ownTruck?: boolean };

export async function addUser(store: UserAdminStore, actor: AuthUser, input: NewUserInput): Promise<AdminUser> {
  guard(actor);
  const role = cleanRole(input.role);
  const data: NewUserData = {
    fullName: cleanName(input.fullName), email: cleanEmail(input.email), phone: cleanPhone(input.phone),
    role, market: cleanMarket(input.market), active: input.active ?? true,
    ownTruck: false,
  };
  if (input.ownTruck && role !== "estimator") throw new UserError("not_an_estimator", "Only an estimator has a truck setting");
  if (role === "estimator" && input.ownTruck) data.ownTruck = true;
  const divisions = role === "production_manager" ? cleanDivisions(input.divisions) : [];
  if (role === "production_manager" && divisions.length && !data.market) throw new UserError("market_required", "Pick a market for a Production Manager who runs divisions");
  if (await store.findByEmail(data.email)) throw new UserError("duplicate_email", "Someone with that email already exists");
  if (divisions.length && data.market) await assertDivisionsFree(store, data.market, divisions);
  const audit: AuditEntry = {
    action: "user.created", entityType: "user", summary: `Added ${who(data)} as ${ROLE_LABELS[role]}`,
    details: { role, market: data.market, active: data.active, divisions, ...(role === "estimator" ? { ownTruck: data.ownTruck ?? false } : {}) },
  };
  return store.create(data, divisions, [audit], { id: actor.id, email: actor.email });
}

export type UserChange = {
  fullName?: string; email?: string; phone?: string | null; role?: string; market?: string | null; divisions?: string[]; active?: boolean;
  ownTruck?: boolean;
};

/** Changes one person. Admin only. An admin cannot change their own role, deactivate themselves, or change their own email. */
export async function changeUser(store: UserAdminStore, actor: AuthUser, id: string, change: UserChange): Promise<AdminUser> {
  guard(actor);
  const before = await store.get(id);
  if (!before) throw new UserError("not_found");
  const self = before.id === actor.id;

  const patch: UserPatch = {};
  const audits: AuditEntry[] = [];
  const base = { entityType: "user", entityId: before.id };

  if (change.fullName !== undefined) {
    const v = cleanName(change.fullName);
    if (v !== before.fullName) patch.fullName = v;
  }
  if (change.email !== undefined) {
    const v = cleanEmail(change.email);
    if (v !== before.email) {
      if (self) throw new UserError("cannot_change_own_email", "Ask another admin to change your email, so a typo cannot lock you out");
      const other = await store.findByEmail(v);
      if (other && other.id !== before.id) throw new UserError("duplicate_email", "Someone with that email already exists");
      patch.email = v;
    }
  }
  if (change.phone !== undefined) {
    const v = cleanPhone(change.phone);
    if (v !== before.phone) patch.phone = v;
  }
  if (change.market !== undefined) {
    const v = cleanMarket(change.market);
    if (v !== before.market) patch.market = v;
  }
  if (change.role !== undefined) {
    const v = cleanRole(change.role);
    if (v !== before.role) {
      if (self) throw new UserError("cannot_change_own_role", "You cannot change your own role. Ask another admin.");
      patch.role = v;
    }
  }
  if (change.active !== undefined && change.active !== before.active) {
    if (self && !change.active) throw new UserError("cannot_deactivate_self", "You cannot deactivate yourself. Ask another admin.");
    patch.active = change.active;
  }

  const role = patch.role ?? before.role;
  if (change.ownTruck !== undefined && change.ownTruck !== before.ownTruck) {
    // Only estimators earn commission by this setting. (A role change in the same request counts.)
    if (role !== "estimator") throw new UserError("not_an_estimator", "Only an estimator has a truck setting");
    patch.ownTruck = change.ownTruck;
  }
  // Leaving the estimator role clears the truck setting, so a stale "own truck" cannot silently apply if they become an estimator again.
  if (role !== "estimator" && before.ownTruck && patch.ownTruck === undefined) patch.ownTruck = false;
  const active = patch.active ?? before.active;
  const market = patch.market !== undefined ? patch.market : before.market;

  // Divisions: only a Production Manager runs divisions. Leaving the role, or being deactivated, drops them,
  // because lead routing and job access read these rows and must not point at someone who is gone.
  let divisionChange: { market: Market | null; list: Division[] } | undefined;
  const asked = change.divisions !== undefined ? cleanDivisions(change.divisions) : undefined;
  if (role !== "production_manager" || !active) {
    if (before.divisions.length) divisionChange = { market: before.market, list: [] };
    if (asked?.length && role !== "production_manager") throw new UserError("not_a_manager", "Only a Production Manager can run divisions");
  } else {
    const next = asked ?? before.divisions;
    const marketMoved = patch.market !== undefined && patch.market !== before.market;
    if (next.length && !market) throw new UserError("market_required", "Pick a market for a Production Manager who runs divisions");
    const changed = asked !== undefined && (asked.length !== before.divisions.length || asked.some((d) => !before.divisions.includes(d)));
    if (changed || (marketMoved && next.length)) {
      if (market && next.length) await assertDivisionsFree(store, market, next, before.id);
      divisionChange = { market: before.market, list: next };
    }
  }

  if (!Object.keys(patch).length && !divisionChange) return before;

  // One audit entry per kind of change, so the screen reads naturally.
  if (patch.role) {
    audits.push({ ...base, action: "user.role_changed", summary: `Changed ${who(before)} from ${ROLE_LABELS[before.role]} to ${ROLE_LABELS[patch.role]}`, details: { from: before.role, to: patch.role } });
  }
  if (patch.active === false) {
    audits.push({ ...base, action: "user.deactivated", summary: `Deactivated ${who(before)}`, details: { clearedDivisions: before.divisions } });
  } else if (patch.active === true) {
    audits.push({ ...base, action: "user.reactivated", summary: `Reactivated ${who(before)}` });
  }
  const profile: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of ["fullName", "email", "phone", "market"] as const) {
    if (patch[k] !== undefined) profile[k] = { from: before[k], to: patch[k] };
  }
  if (Object.keys(profile).length) {
    audits.push({ ...base, action: "user.updated", summary: `Updated ${Object.keys(profile).join(", ")} for ${who(before)}`, details: profile });
  }
  if (patch.ownTruck !== undefined) {
    const label = (b: boolean) => (b ? "own truck (10% base)" : "company truck (8% base)");
    audits.push({
      ...base, action: "user.truck_changed",
      summary: `Changed ${who(before)} from ${label(before.ownTruck)} to ${label(patch.ownTruck)}. Applies to commission on payments collected from now on; earlier entries are not recalculated.`,
      details: { from: before.ownTruck, to: patch.ownTruck },
    });
  }
  if (divisionChange) {
    audits.push({ ...base, action: "user.divisions_changed", summary: `Divisions for ${who(before)}: ${divisionChange.list.length ? divisionChange.list.join(", ") : "none"}`, details: { from: before.divisions, to: divisionChange.list, market: market } });
  }

  // Deactivating or changing a role takes effect now: the person's open sign-in sessions end.
  const revokeSessions = patch.active === false || patch.role !== undefined;
  return store.update(id, patch, { divisions: divisionChange && { market: market ?? divisionChange.market, list: divisionChange.list }, revokeSessions, audits, actor: { id: actor.id, email: actor.email } });
}

export async function listUsers(store: UserAdminStore, actor: AuthUser): Promise<AdminUser[]> {
  guard(actor);
  return store.list();
}
