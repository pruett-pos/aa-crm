import { createHash, randomBytes } from "node:crypto";
import type { AuthStore, AuthUser } from "./store.ts";

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;          // 15 minutes
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;    // 14 days

type Clock = () => Date;

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Create a one-time login token for an active user. Returns the raw token to
 * email, or null when no active user has that email. Callers must respond
 * identically either way so email addresses can't be enumerated.
 */
export async function createLoginToken(
  store: AuthStore, email: string, now: Clock = () => new Date(),
): Promise<{ token: string; user: AuthUser } | null> {
  const user = await store.findUserByEmail(normalizeEmail(email));
  if (!user || !user.active) return null;
  const token = newSecret();
  await store.insertLoginToken({
    hash: hashSecret(token), userId: user.id,
    expiresAt: new Date(now().getTime() + LOGIN_TOKEN_TTL_MS),
  });
  return { token, user };
}

/** Exchange a login token for a session. Tokens are single use. */
export async function redeemLoginToken(
  store: AuthStore, token: string, now: Clock = () => new Date(),
): Promise<{ sessionToken: string; expiresAt: Date; user: AuthUser } | null> {
  const userId = await store.consumeLoginToken(hashSecret(token), now());
  if (!userId) return null;
  const user = await store.findUserById(userId);
  if (!user || !user.active) return null;
  const sessionToken = newSecret();
  const expiresAt = new Date(now().getTime() + SESSION_TTL_MS);
  await store.insertSession({ hash: hashSecret(sessionToken), userId: user.id, expiresAt });
  return { sessionToken, expiresAt, user };
}

/** Resolve a session cookie value to its user; null if missing, expired, or deactivated. */
export async function getSessionUser(
  store: AuthStore, sessionToken: string | undefined, now: Clock = () => new Date(),
): Promise<AuthUser | null> {
  if (!sessionToken) return null;
  const hash = hashSecret(sessionToken);
  const session = await store.findSession(hash);
  if (!session) return null;
  if (session.expiresAt <= now()) {
    await store.deleteSession(hash);
    return null;
  }
  const user = await store.findUserById(session.userId);
  return user && user.active ? user : null;
}

export async function destroySession(store: AuthStore, sessionToken: string | undefined) {
  if (sessionToken) await store.deleteSession(hashSecret(sessionToken));
}
