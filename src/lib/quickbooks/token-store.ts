import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { QboTokens } from "../../integrations/quickbooks/oauth.ts";
import { openSecret, sealSecret } from "../secrets.ts";
import type { QboTokenStore, StoredQboTokens } from "./tokens.ts";

const SYSTEM = "quickbooks";
type Row = { accessTokenEnc: string; refreshTokenEnc: string; expiresAt: Date; ownerId: string | null; status: string; connectedBy: string | null; updatedAt: Date };

/** QuickBooks' tokens in the shared integration credential store, encrypted at rest with INTEGRATION_KEY. owner_id holds the realmId. */
export function createPrismaQboTokenStore(db: PrismaClient, keyB64: () => string | undefined): QboTokenStore {
  const open = (r: Row): StoredQboTokens => ({
    accessToken: openSecret(r.accessTokenEnc, keyB64()), refreshToken: openSecret(r.refreshTokenEnc, keyB64()), expiresAt: r.expiresAt,
    realmId: r.ownerId, status: r.status === "needs_reconnect" ? "needs_reconnect" : "connected", connectedBy: r.connectedBy, updatedAt: r.updatedAt,
  });
  const sealed = (t: QboTokens) => ({ accessTokenEnc: sealSecret(t.accessToken, keyB64()), refreshTokenEnc: sealSecret(t.refreshToken, keyB64()), expiresAt: t.expiresAt, ownerId: t.realmId });

  return {
    async get() {
      const r = await db.integrationCredential.findUnique({ where: { system: SYSTEM } });
      return r ? open(r) : null;
    },
    async withLock(fn) {
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT system FROM integration_credentials WHERE system = ${SYSTEM} FOR UPDATE`;
        const row = await tx.integrationCredential.findUnique({ where: { system: SYSTEM } });
        return fn(row ? open(row) : null, {
          async save(t) {
            await tx.integrationCredential.update({ where: { system: SYSTEM }, data: { ...sealed(t), status: "connected" } });
          },
          async markNeedsReconnect() {
            await tx.integrationCredential.update({ where: { system: SYSTEM }, data: { status: "needs_reconnect" } });
          },
        });
      }, { timeout: 30_000, maxWait: 15_000 });
    },
    async connect(t, connectedBy) {
      const data = { ...sealed(t), status: "connected", connectedBy };
      await db.integrationCredential.upsert({ where: { system: SYSTEM }, create: { system: SYSTEM, ...data }, update: data });
    },
    async disconnect() {
      await db.integrationCredential.deleteMany({ where: { system: SYSTEM } });
    },
  };
}
