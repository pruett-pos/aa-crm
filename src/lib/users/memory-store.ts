import type { AuditActor, AuditEntry } from "../audit/index.ts";
import type { Division } from "../rules.ts";
import type { Market } from "../leads/routing.ts";
import type { AdminUser, DivisionHolder, NewUserData, UserAdminStore, UserPatch } from "./types.ts";

/** In-memory store for tests. Mirrors the Prisma store: user, divisions, audit and sessions change together or not at all. */
export class MemoryUserAdminStore implements UserAdminStore {
  users: AdminUser[] = [];
  /** division_managers rows */
  managers: { division: Division; market: Market; userId: string }[] = [];
  audits: (AuditEntry & { at: Date; actorId: string | null })[] = [];
  revoked: string[] = [];
  private n = 0;

  seed(u: Partial<AdminUser> & { fullName: string; email: string; role: AdminUser["role"] }): AdminUser {
    const user: AdminUser = { id: `u${++this.n}`, phone: null, market: null, active: true, createdAt: new Date(), divisions: [], ...u };
    this.users.push(user);
    for (const d of user.divisions) this.managers.push({ division: d, market: user.market as Market, userId: user.id });
    return user;
  }
  private view(u: AdminUser): AdminUser {
    return { ...u, divisions: this.managers.filter((m) => m.userId === u.id).map((m) => m.division) };
  }
  async list() { return this.users.map((u) => this.view(u)); }
  async get(id: string) { const u = this.users.find((x) => x.id === id); return u ? this.view(u) : null; }
  async findByEmail(email: string) { const u = this.users.find((x) => x.email === email); return u ? this.view(u) : null; }
  async divisionHolders(market: Market, divisions: Division[], exceptUserId?: string): Promise<DivisionHolder[]> {
    return this.managers
      .filter((m) => m.market === market && divisions.includes(m.division) && m.userId !== exceptUserId)
      .map((m) => ({ division: m.division, userId: m.userId, fullName: this.users.find((u) => u.id === m.userId)?.fullName ?? "Someone" }));
  }
  async create(data: NewUserData, divisions: Division[], audits: AuditEntry[], actor: AuditActor) {
    const user = this.seed({ ...data });
    for (const d of divisions) this.managers.push({ division: d, market: data.market as Market, userId: user.id });
    for (const a of audits) this.audits.push({ ...a, entityId: user.id, at: new Date(), actorId: actor.id });
    return this.view(user);
  }
  async update(id: string, patch: UserPatch, change: { divisions?: { market: Market | null; list: Division[] }; revokeSessions: boolean; audits: AuditEntry[]; actor: AuditActor }) {
    const u = this.users.find((x) => x.id === id)!;
    Object.assign(u, patch);
    if (change.divisions) {
      this.managers = this.managers.filter((m) => m.userId !== id);
      for (const d of change.divisions.list) this.managers.push({ division: d, market: change.divisions.market as Market, userId: id });
    }
    if (change.revokeSessions) this.revoked.push(id);
    for (const a of change.audits) this.audits.push({ ...a, at: new Date(), actorId: change.actor.id });
    return this.view(u);
  }
}
