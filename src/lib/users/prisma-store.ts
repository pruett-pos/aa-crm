import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { AuditActor, AuditEntry } from "../audit/index.ts";
import type { Division } from "../rules.ts";
import type { Market } from "../leads/routing.ts";
import { UserError } from "./service.ts";
import type { AdminUser, DivisionHolder, NewUserData, UserAdminStore, UserPatch } from "./types.ts";

type Row = {
  id: string; fullName: string; email: string; phone: string | null; role: AdminUser["role"]; market: Market | null; active: boolean; createdAt: Date;
};
const UUID = /^[0-9a-f-]{36}$/i;
const codeOf = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "");

export function createPrismaUserAdminStore(db: PrismaClient): UserAdminStore {
  const withDivisions = async (rows: Row[]): Promise<AdminUser[]> => {
    const managers = await db.divisionManager.findMany({ where: { userId: { in: rows.map((r) => r.id) } } });
    return rows.map((r) => ({ ...r, divisions: managers.filter((m) => m.userId === r.id).map((m) => m.division as Division) }));
  };
  const auditData = (actorless: AuditEntry, entityId: string) => ({
    action: actorless.action, entityType: actorless.entityType, entityId: actorless.entityId ?? entityId,
    summary: actorless.summary.slice(0, 500), details: (actorless.details ?? undefined) as never,
  });

  return {
    async list() {
      return withDivisions(await db.user.findMany({ orderBy: [{ active: "desc" }, { fullName: "asc" }] }) as Row[]);
    },
    async get(id) {
      if (!UUID.test(id)) return null;
      const r = await db.user.findUnique({ where: { id } });
      return r ? (await withDivisions([r as Row]))[0] : null;
    },
    async findByEmail(email) {
      const r = await db.user.findUnique({ where: { email } });
      return r ? (await withDivisions([r as Row]))[0] : null;
    },
    async divisionHolders(market, divisions, exceptUserId) {
      const rows = await db.divisionManager.findMany({ where: { market, division: { in: divisions }, ...(exceptUserId ? { NOT: { userId: exceptUserId } } : {}) } });
      const names = await db.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, fullName: true } });
      return rows.map((r): DivisionHolder => ({ division: r.division as Division, userId: r.userId, fullName: names.find((n) => n.id === r.userId)?.fullName ?? "Someone" }));
    },

    async create(data: NewUserData, divisions, audits, actor: AuditActor) {
      try {
        const id = await db.$transaction(async (tx) => {
          const u = await tx.user.create({ data: { fullName: data.fullName, email: data.email, phone: data.phone, role: data.role, market: data.market, active: data.active } });
          if (divisions.length && data.market) {
            await tx.divisionManager.createMany({ data: divisions.map((division) => ({ division, market: data.market as Market, userId: u.id })) });
          }
          for (const a of audits) await tx.auditLog.create({ data: { ...auditData(a, u.id), actorId: actor.id, actorEmail: actor.email } });
          return u.id;
        });
        return (await this.get(id))!;
      } catch (e) {
        if (codeOf(e) === "P2002") throw new UserError("duplicate_email", "Someone with that email already exists");
        throw e;
      }
    },

    async update(id, patch: UserPatch, change) {
      try {
        await db.$transaction(async (tx) => {
          if (Object.keys(patch).length) await tx.user.update({ where: { id }, data: patch });
          if (change.divisions) {
            await tx.divisionManager.deleteMany({ where: { userId: id } });
            if (change.divisions.list.length && change.divisions.market) {
              await tx.divisionManager.createMany({ data: change.divisions.list.map((division) => ({ division, market: change.divisions!.market as Market, userId: id })) });
            }
          }
          if (change.revokeSessions) {
            await tx.session.deleteMany({ where: { userId: id } });
            await tx.loginToken.deleteMany({ where: { userId: id } });
          }
          for (const a of change.audits) await tx.auditLog.create({ data: { ...auditData(a, id), actorId: change.actor.id, actorEmail: change.actor.email } });
        });
        return (await this.get(id))!;
      } catch (e) {
        if (codeOf(e) === "P2002") throw new UserError("duplicate_email", "Someone with that email already exists");
        throw e;
      }
    },
  };
}
