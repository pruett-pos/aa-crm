import { cookies } from "next/headers";
import { getSessionUser } from "./core.ts";
import { MemoryAuthStore, type AuthStore, type AuthUser } from "./store.ts";
import { hasRole, type Role } from "./roles.ts";
import { createPrismaAuthStore } from "./prisma-store.ts";
import { getDb } from "../db.ts";

export const SESSION_COOKIE = "aa_session";

// Postgres when DATABASE_URL is set; otherwise an in-memory store for local dev only.
// Kept on globalThis so every route bundle shares one store in dev.
const g = globalThis as unknown as { __aaAuthStore?: AuthStore };
export function getStore(): AuthStore {
  if (g.__aaAuthStore) return g.__aaAuthStore;
  if (process.env.DATABASE_URL) {
    g.__aaAuthStore = createPrismaAuthStore(getDb());
    return g.__aaAuthStore;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is not set");
  }
  const mem = new MemoryAuthStore();
  const email = process.env.DEV_ADMIN_EMAIL;
  if (email) {
    mem.users.push({ id: "dev-admin", fullName: "Dev Admin", email: email.toLowerCase(), role: "admin", active: true });
  }
  g.__aaAuthStore = mem;
  return mem;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const jar = await cookies();
  return getSessionUser(getStore(), jar.get(SESSION_COOKIE)?.value);
}

export type RoleCheck =
  | { ok: true; user: AuthUser }
  | { ok: false; response: Response };

/** For API routes: 401 when signed out, 403 when the role isn't allowed. */
export async function requireRole(...allowed: Role[]): Promise<RoleCheck> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, response: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  if (!hasRole(user.role, allowed)) {
    return { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { ok: true, user };
}
