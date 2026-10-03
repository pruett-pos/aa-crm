import type { Role } from "./roles.ts";

export type AuthUser = {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  active: boolean;
};

/** Everything the auth core needs from storage. Tokens and session ids are stored hashed. */
export interface AuthStore {
  findUserByEmail(email: string): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  insertLoginToken(t: { hash: string; userId: string; expiresAt: Date }): Promise<void>;
  /** Atomically mark an unused, unexpired token as used. Returns its user id, or null. */
  consumeLoginToken(hash: string, now: Date): Promise<string | null>;
  insertSession(s: { hash: string; userId: string; expiresAt: Date }): Promise<void>;
  findSession(hash: string): Promise<{ userId: string; expiresAt: Date } | null>;
  deleteSession(hash: string): Promise<void>;
}

/** In-memory store for tests and database-free local runs. Not for production. */
export class MemoryAuthStore implements AuthStore {
  users: AuthUser[] = [];
  private tokens = new Map<string, { userId: string; expiresAt: Date; usedAt: Date | null }>();
  private sessions = new Map<string, { userId: string; expiresAt: Date }>();

  async findUserByEmail(email: string) {
    return this.users.find((u) => u.email === email) ?? null;
  }
  async findUserById(id: string) {
    return this.users.find((u) => u.id === id) ?? null;
  }
  async insertLoginToken(t: { hash: string; userId: string; expiresAt: Date }) {
    this.tokens.set(t.hash, { userId: t.userId, expiresAt: t.expiresAt, usedAt: null });
  }
  async consumeLoginToken(hash: string, now: Date) {
    const t = this.tokens.get(hash);
    if (!t || t.usedAt || t.expiresAt <= now) return null;
    t.usedAt = now;
    return t.userId;
  }
  async insertSession(s: { hash: string; userId: string; expiresAt: Date }) {
    this.sessions.set(s.hash, { userId: s.userId, expiresAt: s.expiresAt });
  }
  async findSession(hash: string) {
    return this.sessions.get(hash) ?? null;
  }
  async deleteSession(hash: string) {
    this.sessions.delete(hash);
  }
}
