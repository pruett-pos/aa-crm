import type { Role } from "../auth/roles.ts";
import type { Division } from "../rules.ts";
import type { Market } from "../leads/routing.ts";
import type { AuditActor, AuditEntry } from "../audit/index.ts";

export type AdminUser = {
  id: string; fullName: string; email: string; phone: string | null; role: Role; market: Market | null; active: boolean;
  createdAt: Date;
  /** Divisions this person runs as Production Manager (division_managers rows). Empty for every other role. */
  divisions: Division[];
};

export type NewUserData = { fullName: string; email: string; phone: string | null; role: Role; market: Market | null; active: boolean };
export type UserPatch = Partial<NewUserData>;

export type DivisionHolder = { division: Division; userId: string; fullName: string };

/**
 * Storage for user management. `create` and `update` write the user, the division assignments, the audit entries and
 * (when asked) the removal of the user's sign-in sessions in ONE transaction, so an audit entry never exists
 * without its change, or the other way round.
 */
export interface UserAdminStore {
  list(): Promise<AdminUser[]>;
  get(id: string): Promise<AdminUser | null>;
  findByEmail(email: string): Promise<AdminUser | null>;
  /** Who already manages these divisions in this market (excluding one user). */
  divisionHolders(market: Market, divisions: Division[], exceptUserId?: string): Promise<DivisionHolder[]>;
  create(data: NewUserData, divisions: Division[], audits: AuditEntry[], actor: AuditActor): Promise<AdminUser>;
  update(id: string, patch: UserPatch, change: {
    /** New full set of divisions for this user in `market`; undefined leaves division rows alone. */
    divisions?: { market: Market | null; list: Division[] };
    revokeSessions: boolean;
    audits: AuditEntry[];
    actor: AuditActor;
  }): Promise<AdminUser>;
}
