import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.ts";
import type { AuthStore, AuthUser } from "./store.ts";

type DbUser = { id: string; fullName: string; email: string; role: AuthUser["role"]; active: boolean };

function toAuthUser(u: DbUser | null): AuthUser | null {
  return u && { id: u.id, fullName: u.fullName, email: u.email, role: u.role, active: u.active };
}

export function createPrismaAuthStore(connectionString: string): AuthStore {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return {
    async findUserByEmail(email) {
      return toAuthUser(await db.user.findUnique({ where: { email } }));
    },
    async findUserById(id) {
      return toAuthUser(await db.user.findUnique({ where: { id } }));
    },
    async insertLoginToken({ hash, userId, expiresAt }) {
      await db.loginToken.create({ data: { tokenHash: hash, userId, expiresAt } });
    },
    async consumeLoginToken(hash, now) {
      // Single UPDATE keeps "unused and unexpired" atomic, so two clicks can't both win.
      const res = await db.loginToken.updateMany({
        where: { tokenHash: hash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (res.count !== 1) return null;
      const t = await db.loginToken.findUnique({ where: { tokenHash: hash } });
      return t?.userId ?? null;
    },
    async insertSession({ hash, userId, expiresAt }) {
      await db.session.create({ data: { sessionHash: hash, userId, expiresAt } });
    },
    async findSession(hash) {
      const s = await db.session.findUnique({ where: { sessionHash: hash } });
      return s && { userId: s.userId, expiresAt: s.expiresAt };
    },
    async deleteSession(hash) {
      await db.session.deleteMany({ where: { sessionHash: hash } });
    },
  };
}
