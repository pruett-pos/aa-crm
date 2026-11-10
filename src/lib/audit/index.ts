// Audit log: a plain-English record of who changed users and settings. Append-only (the table refuses UPDATE and DELETE).
// Never put secrets, tokens or customer details in `details`.
import { getDb } from "../db.ts";
import { logError } from "../ops/log.ts";

export type AuditActor = { id: string; email: string };
export type AuditEntry = {
  action: string;               // user.created, user.role_changed, settings.product_updated, ...
  entityType: string;           // user, product, commission_schedule, marketing_spend, roofing_assembly, hover
  entityId?: string | null;
  summary: string;              // one line a person can read on the audit screen
  details?: Record<string, unknown>;
};
export type AuditRow = AuditEntry & { id: string; at: Date; actorId: string | null; actorEmail: string | null };

export interface AuditStore {
  record(actor: AuditActor | null, entry: AuditEntry): Promise<void>;
  list(limit: number): Promise<AuditRow[]>;
}

export class MemoryAuditStore implements AuditStore {
  rows: AuditRow[] = [];
  fail = false;
  async record(actor: AuditActor | null, entry: AuditEntry) {
    if (this.fail) throw new Error("audit store down");
    this.rows.push({ ...entry, id: String(this.rows.length + 1), at: new Date(), actorId: actor?.id ?? null, actorEmail: actor?.email ?? null });
  }
  async list(limit: number) {
    return [...this.rows].reverse().slice(0, limit);
  }
}

const g = globalThis as unknown as { __aaAuditStore?: AuditStore };

export function getAuditStore(): AuditStore {
  if (g.__aaAuditStore) return g.__aaAuditStore;
  const db = getDb();
  g.__aaAuditStore = {
    async record(actor, e) {
      await db.auditLog.create({
        data: {
          actorId: actor?.id ?? null, actorEmail: actor?.email ?? null, action: e.action, entityType: e.entityType,
          entityId: e.entityId ?? null, summary: e.summary.slice(0, 500), details: (e.details ?? undefined) as never,
        },
      });
    },
    async list(limit) {
      const rows = await db.auditLog.findMany({ orderBy: { at: "desc" }, take: limit });
      return rows.map((r) => ({
        id: r.id, at: r.at, actorId: r.actorId, actorEmail: r.actorEmail, action: r.action, entityType: r.entityType,
        entityId: r.entityId, summary: r.summary, details: (r.details ?? undefined) as Record<string, unknown> | undefined,
      }));
    },
  };
  return g.__aaAuditStore;
}

/**
 * For settings changes made through the routes: record AFTER the change succeeded. If the audit write itself fails we
 * log it loudly but do not undo or fail the change the admin just made. (User changes are different: they are written
 * in the same database transaction as the change, see src/lib/users/.)
 */
export async function recordAudit(actor: AuditActor, entry: AuditEntry, store: AuditStore = getAuditStore()): Promise<void> {
  try {
    await store.record(actor, entry);
  } catch (e) {
    logError("audit.record_failed", e, { action: entry.action, entityType: entry.entityType });
  }
}
