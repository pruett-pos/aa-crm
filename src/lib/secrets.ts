import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypt a secret (like an OAuth token) before it is stored in the database, with AES-256-GCM.
 * The key is 32 random bytes, base64 encoded, kept only in the server environment (INTEGRATION_KEY).
 * Stored form: v1.<iv>.<tag>.<ciphertext>, all base64url. A changed byte anywhere makes opening fail.
 */
const VERSION = "v1";

function keyBytes(keyB64: string | undefined): Buffer {
  const k = Buffer.from((keyB64 ?? "").trim(), "base64");
  if (k.length !== 32) throw new Error("INTEGRATION_KEY must be 32 bytes, base64 encoded");
  return k;
}

export function sealSecret(plain: string, keyB64: string | undefined): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(keyB64), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** Throws if the key is wrong or the stored text was changed. */
export function openSecret(sealed: string, keyB64: string | undefined): string {
  const [v, iv, tag, ct, ...rest] = sealed.split(".");
  if (v !== VERSION || !iv || !tag || ct === undefined || rest.length > 0) throw new Error("Unreadable stored secret");
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(keyB64), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Unreadable stored secret");
  }
}

/** A fresh key, for setting up a new environment. */
export const newIntegrationKey = (): string => randomBytes(32).toString("base64");
