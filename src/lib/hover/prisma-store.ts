import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { HoverTokens } from "../../integrations/hover/oauth.ts";
import { openSecret, sealSecret } from "../secrets.ts";
import type { HoverTokenStore, StoredHoverTokens } from "./tokens.ts";

const SYSTEM = "hover";
type Row = { accessTokenEnc: string; refreshTokenEnc: string; expiresAt: Date; ownerId: string | null; status: string; connectedBy: string | null; updatedAt: Date };

/** Hover's tokens, encrypted at rest with INTEGRATION_KEY. Reading fails loudly if the key is missing or wrong. */
export function createPrismaHoverTokenStore(db: PrismaClient, keyB64: () => string | undefined): HoverTokenStore {
  const open = (r: Row): StoredHoverTokens => ({
    accessToken: openSecret(r.accessTokenEnc, keyB64()), refreshToken: openSecret(r.refreshTokenEnc, keyB64()), expiresAt: r.expiresAt,
    ownerId: r.ownerId, status: r.status === "needs_reconnect" ? "needs_reconnect" : "connected", connectedBy: r.connectedBy, updatedAt: r.updatedAt,
  });
  const sealed = (t: HoverTokens) => ({ accessTokenEnc: sealSecret(t.accessToken, keyB64()), refreshTokenEnc: sealSecret(t.refreshToken, keyB64()), expiresAt: t.expiresAt, ownerId: t.ownerId });

  return {
    async get() {
      const r = await db.integrationCredential.findUnique({ where: { system: SYSTEM } });
      return r ? open(r) : null;
    },

    async withLock(fn) {
      // The row lock makes concurrent refreshes take turns. Hover's refresh call is slow, so the transaction gets extra time.
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
