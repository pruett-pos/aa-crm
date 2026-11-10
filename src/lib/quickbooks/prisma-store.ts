import type { PrismaClient } from "../../generated/prisma/client.ts";
import type {
  CrmCustomer, CrmInvoice, CrmPayment, InvoicePayload, Link, LinkType, NewSyncJob, QboSettings, QboStore, SyncJob, SyncKind, SyncPatch, SyncStatus,
} from "./types.ts";

// Raw SQL on purpose: these tables are new (db/migrations/015_quickbooks.sql) and are read and written only here.
type JobRow = {
  id: string; kind: string; entity_id: string; status: string; attempts: number; next_attempt_at: Date; locked_at: Date | null; last_error: string | null;
  qbo_id: string | null; request_id: string; payload: unknown; crm_total_cents: bigint | null; qbo_total_cents: bigint | null; mismatch: boolean;
  created_at: Date; updated_at: Date;
};
const num = (v: bigint | number | null) => (v === null || v === undefined ? null : Number(v));
const toJob = (r: JobRow): SyncJob => ({
  id: r.id, kind: r.kind as SyncKind, entityId: r.entity_id, status: r.status as SyncStatus, attempts: r.attempts, nextAttemptAt: r.next_attempt_at,
  lockedAt: r.locked_at, lastError: r.last_error, qboId: r.qbo_id, requestId: r.request_id, payload: (r.payload as InvoicePayload | null) ?? null,
  crmTotalCents: num(r.crm_total_cents), qboTotalCents: num(r.qbo_total_cents), mismatch: r.mismatch, createdAt: r.created_at, updatedAt: r.updated_at,
});

type InvRow = {
  id: string; job_id: string; job_number: number; invoice_number: number; issued_at: Date; due_on: string; contract_cents: bigint; status: string; source: string;
  customer_id: string; first_name: string; last_name: string; email: string | null; phone: string | null; street: string; city: string; state: string; zip: string;
};
type PayRow = {
  id: string; job_id: string; job_number: number; amount_cents: bigint; method: string; reference: string | null; is_deposit: boolean; received_at: Date; voided_at: Date | null;
  customer_id: string; first_name: string; last_name: string; email: string | null; phone: string | null;
};
const cust = (r: { customer_id: string; first_name: string; last_name: string; email: string | null; phone: string | null }): CrmCustomer =>
  ({ id: r.customer_id, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone });

export function createPrismaQboStore(db: PrismaClient): QboStore {
  const jobById = async (id: string) => {
    const r = await db.$queryRaw<JobRow[]>`SELECT * FROM qbo_sync_jobs WHERE id = ${id}::uuid`;
    return r[0] ? toJob(r[0]) : null;
  };
  const getInvoice = async (where: "id" | "live", v: string): Promise<CrmInvoice | null> => {
    const rows = where === "id"
      ? await db.$queryRaw<InvRow[]>`
          SELECT i.id, i.job_id, j.job_number, i.invoice_number, i.issued_at, i.due_on::text AS due_on, i.contract_cents, i.status, j.source::text AS source,
                 c.id AS customer_id, c.first_name, c.last_name, c.email, c.phone, p.street, p.city, p.state, p.zip
          FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN properties p ON p.id = j.property_id JOIN customers c ON c.id = p.customer_id
          WHERE i.id = ${v}::uuid`
      : await db.$queryRaw<InvRow[]>`
          SELECT i.id, i.job_id, j.job_number, i.invoice_number, i.issued_at, i.due_on::text AS due_on, i.contract_cents, i.status, j.source::text AS source,
                 c.id AS customer_id, c.first_name, c.last_name, c.email, c.phone, p.street, p.city, p.state, p.zip
          FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN properties p ON p.id = j.property_id JOIN customers c ON c.id = p.customer_id
          WHERE i.job_id = ${v}::uuid AND i.status = 'issued'`;
    const r = rows[0];
    return r ? {
      id: r.id, jobId: r.job_id, jobNumber: r.job_number, invoiceNumber: r.invoice_number, issuedAt: r.issued_at, dueOn: r.due_on, contractCents: Number(r.contract_cents),
      status: r.status === "void" ? "void" : "issued", source: r.source, customer: cust(r), property: { street: r.street, city: r.city, state: r.state, zip: r.zip },
    } : null;
  };

  return {
    async enqueue(j: NewSyncJob, now) {
      const payload = j.payload ? JSON.stringify(j.payload) : null;
      // ON CONFLICT DO NOTHING + re-read: two callers racing to queue the same record get the same job.
      await db.$executeRaw`
        INSERT INTO qbo_sync_jobs (kind, entity_id, request_id, payload, crm_total_cents, next_attempt_at, created_at, updated_at)
        VALUES (${j.kind}, ${j.entityId}::uuid, ${crypto.randomUUID()}, ${payload}::jsonb, ${j.crmTotalCents ?? null}, ${now}, ${now}, ${now})
        ON CONFLICT (kind, entity_id) DO NOTHING`;
      const r = await db.$queryRaw<JobRow[]>`SELECT * FROM qbo_sync_jobs WHERE kind = ${j.kind} AND entity_id = ${j.entityId}::uuid`;
      return toJob(r[0]);
    },
    getJob: jobById,
    async findJob(kind, entityId) {
      const r = await db.$queryRaw<JobRow[]>`SELECT * FROM qbo_sync_jobs WHERE kind = ${kind} AND entity_id = ${entityId}::uuid`;
      return r[0] ? toJob(r[0]) : null;
    },
    async claimDue(now, limit, staleMs) {
      const stale = new Date(now.getTime() - staleMs);
      // SKIP LOCKED: two workers (cron + "Sync now") never take the same job.
      const rows = await db.$queryRaw<JobRow[]>`
        UPDATE qbo_sync_jobs SET status = 'running', locked_at = ${now}, updated_at = ${now}
        WHERE id IN (
          SELECT id FROM qbo_sync_jobs
          WHERE (status IN ('pending','waiting') AND next_attempt_at <= ${now}) OR (status = 'running' AND locked_at < ${stale})
          ORDER BY created_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        RETURNING *`;
      return rows.map(toJob).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async updateJob(id, p: SyncPatch, now) {
      const cur = await jobById(id);
      if (!cur) return;
      const m = { ...cur, ...p };
      await db.$executeRaw`
        UPDATE qbo_sync_jobs SET status = ${m.status}, attempts = ${m.attempts}, next_attempt_at = ${m.nextAttemptAt}, locked_at = ${m.lockedAt},
          last_error = ${m.lastError}, qbo_id = ${m.qboId}, request_id = ${m.requestId}, qbo_total_cents = ${m.qboTotalCents}, mismatch = ${m.mismatch}, updated_at = ${now}
        WHERE id = ${id}::uuid`;
    },
    async listJobs(f) {
      const statuses = f.statuses ?? ["pending", "waiting", "running", "done", "failed", "cancelled"];
      const rows = await db.$queryRaw<JobRow[]>`
        SELECT * FROM qbo_sync_jobs WHERE status = ANY(${statuses}::text[]) AND (${!f.mismatchOnly} OR mismatch)
        ORDER BY updated_at DESC LIMIT ${f.limit}`;
      return rows.map(toJob);
    },
    async counts() {
      const rows = await db.$queryRaw<{ status: string; n: bigint; mm: bigint }[]>`SELECT status, count(*) AS n, count(*) FILTER (WHERE mismatch) AS mm FROM qbo_sync_jobs GROUP BY status`;
      const c = { pending: 0, waiting: 0, running: 0, done: 0, failed: 0, cancelled: 0, mismatch: 0 };
      for (const r of rows) { c[r.status as SyncStatus] = Number(r.n); c.mismatch += Number(r.mm); }
      return c;
    },

    async getLink(t: LinkType, id) {
      const r = await db.$queryRaw<{ qbo_id: string; parent_qbo_id: string | null }[]>`SELECT qbo_id, parent_qbo_id FROM qbo_links WHERE entity_type = ${t} AND entity_id = ${id}::uuid`;
      return r[0] ? ({ qboId: r[0].qbo_id, parentQboId: r[0].parent_qbo_id } satisfies Link) : null;
    },
    async setLink(t, id, qboId, parent = null) {
      await db.$executeRaw`
        INSERT INTO qbo_links (entity_type, entity_id, qbo_id, parent_qbo_id) VALUES (${t}, ${id}::uuid, ${qboId}, ${parent})
        ON CONFLICT (entity_type, entity_id) DO UPDATE SET qbo_id = EXCLUDED.qbo_id, parent_qbo_id = EXCLUDED.parent_qbo_id`;
    },
    async deleteLink(t, id) {
      await db.$executeRaw`DELETE FROM qbo_links WHERE entity_type = ${t} AND entity_id = ${id}::uuid`;
    },
    async paymentIdsLinkedToInvoice(invoiceQboId) {
      const r = await db.$queryRaw<{ entity_id: string }[]>`SELECT entity_id FROM qbo_links WHERE entity_type = 'payment' AND parent_qbo_id = ${invoiceQboId}`;
      return r.map((x) => x.entity_id);
    },
    async getRef(kind, key) {
      const r = await db.$queryRaw<{ qbo_id: string }[]>`SELECT qbo_id FROM qbo_refs WHERE kind = ${kind} AND key = ${key}`;
      return r[0]?.qbo_id ?? null;
    },
    async setRef(kind, key, id) {
      await db.$executeRaw`INSERT INTO qbo_refs (kind, key, qbo_id) VALUES (${kind}, ${key}, ${id}) ON CONFLICT (kind, key) DO UPDATE SET qbo_id = EXCLUDED.qbo_id`;
    },
    async getClassMap() {
      const r = await db.$queryRaw<{ lead_source: string; class_name: string }[]>`SELECT lead_source, class_name FROM qbo_class_map`;
      return Object.fromEntries(r.map((x) => [x.lead_source, x.class_name]));
    },
    async setClassMap(m) {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM qbo_class_map`;
        for (const [k, v] of Object.entries(m)) await tx.$executeRaw`INSERT INTO qbo_class_map (lead_source, class_name) VALUES (${k}, ${v})`;
      });
    },
    async getItemMap() {
      const r = await db.$queryRaw<{ division: string; item_name: string }[]>`SELECT division, item_name FROM qbo_item_map`;
      return Object.fromEntries(r.map((x) => [x.division, x.item_name]));
    },
    async setItemMap(m) {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM qbo_item_map`;
        for (const [k, v] of Object.entries(m)) await tx.$executeRaw`INSERT INTO qbo_item_map (division, item_name) VALUES (${k}, ${v})`;
      });
    },
    async getSettings(): Promise<QboSettings> {
      const r = await db.$queryRaw<{ key: string; value: string }[]>`SELECT key, value FROM qbo_settings`;
      const m = Object.fromEntries(r.map((x) => [x.key, x.value]));
      const date = (v?: string) => (v ? new Date(v) : null);
      return { realmId: m.realm_id ?? null, companyName: m.company_name ?? null, environment: m.environment ?? null, connectedAt: date(m.connected_at), syncFrom: date(m.sync_from) };
    },
    async saveConnection(s, now) {
      return db.$transaction(async (tx) => {
        const cur = await tx.$queryRaw<{ key: string; value: string }[]>`SELECT key, value FROM qbo_settings`;
        const m = Object.fromEntries(cur.map((x) => [x.key, x.value]));
        const changed = m.realm_id !== undefined && (m.realm_id !== s.realmId || m.environment !== s.environment);
        if (changed) {
          // A different QuickBooks company (or sandbox -> production): ids and history from the old one mean nothing here.
          await tx.$executeRaw`DELETE FROM qbo_links`;
          await tx.$executeRaw`DELETE FROM qbo_refs`;
          await tx.$executeRaw`DELETE FROM qbo_sync_jobs`;
        }
        const syncFrom = m.realm_id === undefined || changed || !m.sync_from ? now.toISOString() : m.sync_from;
        const put = (k: string, v: string) => tx.$executeRaw`INSERT INTO qbo_settings (key, value, updated_at) VALUES (${k}, ${v}, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
        await put("realm_id", s.realmId); await put("company_name", s.companyName); await put("environment", s.environment);
        await put("connected_at", now.toISOString()); await put("sync_from", syncFrom);
        return { companyChanged: changed };
      });
    },
    async clearConnection() { /* tokens are removed by the token store; links and sync_from stay for a reconnect to the same company */ },

    getInvoice: (id) => getInvoice("id", id),
    liveInvoiceForJob: (jobId) => getInvoice("live", jobId),
    async invoiceLines(invoiceId) {
      const r = await db.$queryRaw<{ division: string; title: string; sale_cents: bigint }[]>`
        SELECT s.division::text AS division, s.title, s.sale_cents FROM scopes s JOIN invoices i ON i.job_id = s.job_id
        WHERE i.id = ${invoiceId}::uuid AND s.selected ORDER BY s.division`;
      return r.map((x) => ({ division: x.division as InvoicePayload["lines"][number]["division"], description: x.title, amountCents: Number(x.sale_cents) }));
    },
    async getPayment(id): Promise<CrmPayment | null> {
      const r = await db.$queryRaw<PayRow[]>`
        SELECT pay.id, pay.job_id, j.job_number, pay.amount_cents, pay.method::text AS method, pay.reference, pay.is_deposit, pay.received_at, pay.voided_at,
               c.id AS customer_id, c.first_name, c.last_name, c.email, c.phone
        FROM payments pay JOIN jobs j ON j.id = pay.job_id JOIN properties p ON p.id = j.property_id JOIN customers c ON c.id = p.customer_id
        WHERE pay.id = ${id}::uuid`;
      const x = r[0];
      return x ? { id: x.id, jobId: x.job_id, jobNumber: x.job_number, amountCents: Number(x.amount_cents), method: x.method, reference: x.reference, isDeposit: x.is_deposit, receivedAt: x.received_at, voidedAt: x.voided_at, customer: cust(x) } : null;
    },
    async invoiceIdsMissingJob(since, limit) {
      const r = await db.$queryRaw<{ id: string }[]>`
        SELECT i.id FROM invoices i WHERE i.issued_at >= ${since}
          AND NOT EXISTS (SELECT 1 FROM qbo_sync_jobs q WHERE q.kind = 'invoice' AND q.entity_id = i.id) ORDER BY i.issued_at LIMIT ${limit}`;
      return r.map((x) => x.id);
    },
    async paymentIdsMissingJob(since, limit) {
      const r = await db.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM payments p WHERE p.received_at >= ${since}
          AND NOT EXISTS (SELECT 1 FROM qbo_sync_jobs q WHERE q.kind = 'payment' AND q.entity_id = p.id) ORDER BY p.received_at LIMIT ${limit}`;
      return r.map((x) => x.id);
    },
    async voidedInvoiceIdsMissingVoidJob(limit) {
      const r = await db.$queryRaw<{ id: string }[]>`
        SELECT i.id FROM invoices i WHERE i.status = 'void'
          AND EXISTS (SELECT 1 FROM qbo_sync_jobs q WHERE q.kind = 'invoice' AND q.entity_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM qbo_sync_jobs q WHERE q.kind = 'void_invoice' AND q.entity_id = i.id) LIMIT ${limit}`;
      return r.map((x) => x.id);
    },
    async voidedPaymentIdsMissingVoidJob(limit) {
      const r = await db.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM payments p WHERE p.voided_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM qbo_sync_jobs q WHERE q.kind = 'payment' AND q.entity_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM qbo_sync_jobs q WHERE q.kind = 'void_payment' AND q.entity_id = p.id) LIMIT ${limit}`;
      return r.map((x) => x.id);
    },
  };
}
