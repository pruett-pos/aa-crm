// The QuickBooks push engine: queue a job for each thing that must reach QuickBooks, then work through the queue.
// One-way (CRM -> QBO). Idempotent: a CRM record is linked to its QBO record once it exists, every create carries the job's
// fixed RequestId, and invoices are looked up by number before creating. Failures are kept on the job and retried with backoff.
import { QboError, isRetryable } from "../../integrations/quickbooks/errors.ts";
import type { QboClient } from "../../integrations/quickbooks/client.ts";
import { en } from "../../i18n/en.ts";
import { localDate } from "../commission/periods.ts";
import type { QboCustomer } from "../../integrations/quickbooks/client.ts";
import type { CrmAddress, CrmCustomer, CrmInvoice, CrmPayment, QboStore, SyncJob } from "./types.ts";

export const MAX_ATTEMPTS = 8;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 12 * 60 * 60_000];
const WAIT_MS = 2 * 60_000;                 // a job waiting on another (a payment before its invoice is in QuickBooks)
const STALE_RUNNING_MS = 10 * 60_000;       // a "running" job this old was abandoned by a crashed worker
const AUTH_PAUSE_MS = 15 * 60_000;
const SWEEP_LIMIT = 200;

export const backoffMs = (attemptsSoFar: number) => BACKOFF_MS[Math.min(Math.max(attemptsSoFar, 1), BACKOFF_MS.length) - 1];

/** QuickBooks payment method names for the CRM's methods (created in QuickBooks if missing). */
export const PAYMENT_METHOD_NAMES: Record<string, string> = {
  check: "Check", card: "Credit Card", ach: "ACH", cash: "Cash", insurance_check: "Insurance check", financing: "Financing",
};

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const trim = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const fmtPhone = (s: string | null) => { const d = digits(s); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : (s?.trim() || null); };

export type Deps = { store: QboStore; client: QboClient; now?: () => Date };
const nowOf = (d: { now?: () => Date }) => (d.now ?? (() => new Date()))();

// ---------- names ----------
export const defaultClassName = (source: string) => (en.leads.sources as Record<string, string>)[source] ?? source;
export const defaultItemName = (division: string) => (en.leads.divisionNames as Record<string, string>)[division] ?? division;

// ---------- queueing ----------
export async function enqueueInvoice(store: QboStore, invoiceId: string, now: Date): Promise<SyncJob | null> {
  const inv = await store.getInvoice(invoiceId);
  if (!inv) return null;
  const lines = await store.invoiceLines(invoiceId);
  return store.enqueue({ kind: "invoice", entityId: invoiceId, payload: { lines }, crmTotalCents: inv.contractCents }, now);
}

export async function enqueuePayment(store: QboStore, paymentId: string, now: Date): Promise<SyncJob | null> {
  const p = await store.getPayment(paymentId);
  return p ? store.enqueue({ kind: "payment", entityId: paymentId, crmTotalCents: p.amountCents }, now) : null;
}

/**
 * Queue whatever isn't queued yet. Called right after an invoice is issued or a payment is recorded or voided, and by the
 * cron script, so nothing is lost if the process stopped between saving the record and queueing it. Only records from
 * the moment QuickBooks was connected are queued, so connecting never pushes the whole history by accident.
 */
export async function sweep(store: QboStore, now: Date = new Date()): Promise<{ queued: number }> {
  const s = await store.getSettings();
  if (!s.syncFrom || !s.realmId) return { queued: 0 };
  let queued = 0;
  for (const id of await store.invoiceIdsMissingJob(s.syncFrom, SWEEP_LIMIT)) if (await enqueueInvoice(store, id, now)) queued++;
  for (const id of await store.paymentIdsMissingJob(s.syncFrom, SWEEP_LIMIT)) if (await enqueuePayment(store, id, now)) queued++;
  for (const id of await store.voidedInvoiceIdsMissingVoidJob(SWEEP_LIMIT)) { await store.enqueue({ kind: "void_invoice", entityId: id }, now); queued++; }
  for (const id of await store.voidedPaymentIdsMissingVoidJob(SWEEP_LIMIT)) { await store.enqueue({ kind: "void_payment", entityId: id }, now); queued++; }
  return { queued };
}

// ---------- push helpers ----------
type Outcome = { type: "done"; qboId: string | null; qboTotalCents?: number; crmTotalCents?: number }
  | { type: "wait"; reason: string }
  | { type: "cancel"; reason: string };

// Same-person rules. Case, spacing and punctuation never matter.
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const zip5 = (s: string | null | undefined) => digits(s).slice(0, 5);
const sameName = (q: QboCustomer, first: string, last: string) =>
  norm(q.displayName) === norm(`${first} ${last}`) || (!!q.givenName && !!q.familyName && norm(`${q.givenName} ${q.familyName}`) === norm(`${first} ${last}`));
const sameAddress = (q: QboCustomer, a: CrmAddress | null) =>
  !!a && !!q.address && norm(q.address.line1) === norm(a.street) && !!zip5(a.zip) && zip5(q.address.postalCode) === zip5(a.zip);

/**
 * A QuickBooks customer is the same person only when the NAME matches AND the email OR the street + zip matches.
 * Name alone is not enough: `possible` holds those, so the caller can flag them for an admin.
 */
export function matchQboCustomer(c: CrmCustomer, address: CrmAddress | null, found: QboCustomer[]): { match: QboCustomer | null; possible: QboCustomer[] } {
  const named = found.filter((f) => sameName(f, c.firstName, c.lastName));
  const email = c.email?.trim().toLowerCase();
  const match = named.find((f) => !!email && f.email?.trim().toLowerCase() === email) ?? named.find((f) => sameAddress(f, address)) ?? null;
  return { match, possible: match ? [] : named };
}

async function ensureCustomer(d: Deps, c: CrmCustomer, address: CrmAddress | null): Promise<string> {
  const linked = await d.store.getLink("customer", c.id);
  if (linked) return linked.qboId;

  const fullName = `${c.firstName} ${c.lastName}`.trim();
  const phone = fmtPhone(c.phone);
  const found = await d.client.findCustomers({ email: c.email?.trim() || null, displayName: fullName });
  const { match, possible } = matchQboCustomer(c, address, found);
  if (match) {
    await d.store.setLink("customer", c.id, match.id);
    return match.id;
  }
  const make = (displayName: string, requestId: string) =>
    d.client.createCustomer({
      requestId, displayName, givenName: c.firstName, familyName: c.lastName, email: c.email?.trim() || null, phone,
      address: address ? { line1: address.street, city: address.city, state: address.state, postalCode: address.zip } : null,
    });
  let created: { id: string };
  try {
    created = await make(fullName, c.id);
  } catch (e) {
    // The name is taken (QuickBooks names must be unique) by someone who didn't match. Make ours distinct and stable.
    if (!(e instanceof QboError) || e.kind !== "duplicate") throw e;
    created = await make(`${fullName} (${c.id.slice(0, 8)})`, `${c.id}-n`.slice(0, 50));
  }
  await d.store.setLink("customer", c.id, created.id);
  if (possible.length) {
    await d.store.addDuplicateFlag({
      customerId: c.id, customerName: fullName, createdQboId: created.id,
      candidates: possible.slice(0, 5).map((q) => ({ id: q.id, displayName: q.displayName, email: q.email })),
    }, nowOf(d));
  }
  return created.id;
}

/** Admin chose an existing QuickBooks customer for a flagged one. Only the candidates QuickBooks showed can be chosen. */
export async function linkToExistingCustomer(store: QboStore, customerId: string, qboId: string, now: Date = new Date()): Promise<boolean> {
  const f = await store.getDuplicateFlag(customerId);
  if (!f || f.status !== "open" || !f.candidates.some((c) => c.id === qboId)) return false;
  await store.setLink("customer", customerId, qboId);
  await store.resolveDuplicateFlag(customerId, "linked", now);
  return true;
}

/** Admin says the flagged customer really is someone else: keep the new QuickBooks customer. */
export async function dismissDuplicateFlag(store: QboStore, customerId: string, now: Date = new Date()): Promise<boolean> {
  const f = await store.getDuplicateFlag(customerId);
  if (!f || f.status !== "open") return false;
  await store.resolveDuplicateFlag(customerId, "dismissed", now);
  return true;
}

async function ensureClass(d: Deps, source: string): Promise<string> {
  const map = await d.store.getClassMap();
  const name = map[source] ?? defaultClassName(source);
  const cached = await d.store.getRef("class", name);
  if (cached) return cached;
  const id = (await d.client.findClassByName(name)) ?? (await d.client.createClass(name, `class-${name}`.slice(0, 50)));
  await d.store.setRef("class", name, id);
  return id;
}

async function ensureItem(d: Deps, division: string, itemMap: Record<string, string>): Promise<string> {
  const name = itemMap[division] ?? defaultItemName(division);
  const cached = await d.store.getRef("item", name);
  if (cached) return cached;
  let id = await d.client.findItemByName(name);
  if (!id) {
    const account = await d.client.findIncomeAccountId();
    if (!account) throw new QboError("validation", "QuickBooks has no income account to attach the new service item to");
    id = await d.client.createServiceItem(name, account, `item-${name}`.slice(0, 50));
  }
  await d.store.setRef("item", name, id);
  return id;
}

async function ensurePaymentMethod(d: Deps, method: string): Promise<string | null> {
  const name = PAYMENT_METHOD_NAMES[method];
  if (!name) return null;
  const cached = await d.store.getRef("payment_method", name);
  if (cached) return cached;
  const id = (await d.client.findPaymentMethodByName(name)) ?? (await d.client.createPaymentMethod(name, `pm-${name}`.slice(0, 50)));
  await d.store.setRef("payment_method", name, id);
  return id;
}

// ---------- the four kinds of push ----------
async function pushInvoice(d: Deps, job: SyncJob): Promise<Outcome> {
  const inv = await d.store.getInvoice(job.entityId);
  if (!inv) return { type: "cancel", reason: "The invoice no longer exists" };
  const existing = await d.store.getLink("invoice", inv.id);
  if (existing) return { type: "done", qboId: existing.qboId };
  if (inv.status === "void") return { type: "cancel", reason: "Voided before it was sent to QuickBooks" };
  const lines = job.payload?.lines ?? [];
  if (!lines.length) throw new QboError("validation", "The invoice has no trade lines to send");

  const customerId = await ensureCustomer(d, inv.customer, inv.property);
  const classId = await ensureClass(d, inv.source);
  const itemMap = await d.store.getItemMap();
  const qLines = [];
  for (const l of lines) qLines.push({ itemId: await ensureItem(d, l.division, itemMap), description: l.description, amountCents: l.amountCents });

  // Look the number up first: a copy QuickBooks already has (from a reply we lost) is adopted, never duplicated.
  let q = await d.client.findInvoiceByDocNumber(String(inv.invoiceNumber));
  if (q && q.customerId !== customerId) throw new QboError("validation", `QuickBooks already has a different invoice numbered ${inv.invoiceNumber}`);
  q ??= await d.client.createInvoice({
    requestId: job.requestId, customerId, classId, docNumber: String(inv.invoiceNumber),
    txnDate: localDate(inv.issuedAt), dueDate: inv.dueOn, lines: qLines,
    address: { line1: inv.property.street, city: inv.property.city, state: inv.property.state, postalCode: inv.property.zip },
    memo: `A&A CRM job ${inv.jobNumber}, invoice ${inv.invoiceNumber}`,
  });
  await d.store.setLink("invoice", inv.id, q.id);
  return { type: "done", qboId: q.id, qboTotalCents: q.totalCents, crmTotalCents: inv.contractCents };
}

async function pushPayment(d: Deps, job: SyncJob): Promise<Outcome> {
  const p = await d.store.getPayment(job.entityId);
  if (!p) return { type: "cancel", reason: "The payment no longer exists" };
  const existing = await d.store.getLink("payment", p.id);
  if (existing) return { type: "done", qboId: existing.qboId };
  if (p.voidedAt) return { type: "cancel", reason: "Voided before it was sent to QuickBooks" };

  const inv = await d.store.liveInvoiceForJob(p.jobId);
  if (!inv) return { type: "wait", reason: "Waiting for the job's invoice" };
  const invLink = await d.store.getLink("invoice", inv.id);
  if (!invLink) return { type: "wait", reason: `Waiting for invoice ${inv.invoiceNumber} to reach QuickBooks` };

  const customerId = await ensureCustomer(d, p.customer, inv.property);
  const methodId = await ensurePaymentMethod(d, p.method);
  const made = await d.client.createPayment({
    requestId: job.requestId, customerId, invoiceId: invLink.qboId, amountCents: p.amountCents, txnDate: localDate(p.receivedAt),
    paymentMethodId: methodId, reference: p.reference, memo: `A&A CRM job ${p.jobNumber}${p.isDeposit ? ", deposit" : ""}`,
  });
  await d.store.setLink("payment", p.id, made.id, invLink.qboId);
  return { type: "done", qboId: made.id, qboTotalCents: made.totalCents, crmTotalCents: p.amountCents };
}

async function pushVoidPayment(d: Deps, job: SyncJob): Promise<Outcome> {
  const link = await d.store.getLink("payment", job.entityId);
  if (!link) {
    const create = await d.store.findJob("payment", job.entityId);
    if (create && create.status === "running") return { type: "wait", reason: "Waiting for the payment to finish sending" };
    if (create && ["pending", "waiting", "failed"].includes(create.status)) await d.store.updateJob(create.id, { status: "cancelled", lastError: "Voided before it was sent to QuickBooks" }, nowOf(d));
    return { type: "done", qboId: null };            // nothing in QuickBooks to void
  }
  await d.client.voidPayment(link.qboId);
  await d.store.deleteLink("payment", job.entityId);
  return { type: "done", qboId: link.qboId };
}

async function pushVoidInvoice(d: Deps, job: SyncJob): Promise<Outcome> {
  const link = await d.store.getLink("invoice", job.entityId);
  if (!link) {
    const create = await d.store.findJob("invoice", job.entityId);
    if (create && create.status === "running") return { type: "wait", reason: "Waiting for the invoice to finish sending" };
    if (create && ["pending", "waiting", "failed"].includes(create.status)) await d.store.updateJob(create.id, { status: "cancelled", lastError: "Voided before it was sent to QuickBooks" }, nowOf(d));
    return { type: "done", qboId: null };
  }
  // QuickBooks won't void an invoice that has payments applied. Void those first; the CRM payments are still good, so each
  // one is queued again (with a fresh RequestId) and will be applied to the replacement invoice.
  for (const paymentId of await d.store.paymentIdsLinkedToInvoice(link.qboId)) {
    const pl = await d.store.getLink("payment", paymentId);
    if (!pl) continue;
    await d.client.voidPayment(pl.qboId);
    await d.store.deleteLink("payment", paymentId);
    const pj = await d.store.findJob("payment", paymentId);
    const crmPayment = await d.store.getPayment(paymentId);
    if (pj && crmPayment && !crmPayment.voidedAt) {
      await d.store.updateJob(pj.id, { status: "waiting", attempts: 0, nextAttemptAt: nowOf(d), lastError: "Waiting for the replacement invoice", qboId: null, qboTotalCents: null, mismatch: false, requestId: crypto.randomUUID() }, nowOf(d));
    }
  }
  await d.client.voidInvoice(link.qboId);
  await d.store.deleteLink("invoice", job.entityId);
  return { type: "done", qboId: link.qboId };
}

const HANDLERS = { invoice: pushInvoice, payment: pushPayment, void_invoice: pushVoidInvoice, void_payment: pushVoidPayment } as const;

// ---------- working the queue ----------
export type Tally = { done: number; waiting: number; retrying: number; failed: number; cancelled: number; mismatches: number; stoppedForAuth: boolean };

async function runOne(d: Deps, job: SyncJob, tally: Tally): Promise<void> {
  const now = nowOf(d);
  try {
    const out = await HANDLERS[job.kind](d, job);
    if (out.type === "wait") {
      await d.store.updateJob(job.id, { status: "waiting", lockedAt: null, nextAttemptAt: new Date(now.getTime() + WAIT_MS), lastError: out.reason }, now);
      tally.waiting++;
    } else if (out.type === "cancel") {
      await d.store.updateJob(job.id, { status: "cancelled", lockedAt: null, lastError: out.reason }, now);
      tally.cancelled++;
    } else {
      // Round-trip check: what QuickBooks recorded must equal what the CRM says, to the cent.
      const crm = out.crmTotalCents ?? job.crmTotalCents, qbo = out.qboTotalCents;
      const mismatch = qbo !== undefined && crm !== null && crm !== undefined && qbo !== crm;
      await d.store.updateJob(job.id, {
        status: "done", lockedAt: null, qboId: out.qboId, qboTotalCents: qbo ?? job.qboTotalCents, mismatch,
        lastError: mismatch ? `QuickBooks recorded ${dollars(qbo as number)} but the CRM says ${dollars(crm as number)}. Check tax and discount settings in QuickBooks.` : null,
      }, now);
      tally.done++;
      if (mismatch) tally.mismatches++;
    }
  } catch (e) {
    const err = e instanceof QboError ? e : null;
    const message = trim(err ? err.message : "Unexpected error while sending to QuickBooks");
    if (!err) console.error(`quickbooks job ${job.id} (${job.kind}) failed: ${e instanceof Error ? e.name : "unknown"}`);   // never the message: it could hold customer data
    if (err?.kind === "auth") {
      // Not the job's fault and not worth an attempt: hold it until an admin reconnects.
      await d.store.updateJob(job.id, { status: "pending", lockedAt: null, nextAttemptAt: new Date(now.getTime() + AUTH_PAUSE_MS), lastError: message }, now);
      tally.stoppedForAuth = true;
      return;
    }
    const attempts = job.attempts + 1;
    if (err && !isRetryable(err.kind) || attempts >= MAX_ATTEMPTS) {
      await d.store.updateJob(job.id, { status: "failed", lockedAt: null, attempts, lastError: message }, now);
      tally.failed++;
    } else {
      await d.store.updateJob(job.id, { status: "pending", lockedAt: null, attempts, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)), lastError: message }, now);
      tally.retrying++;
    }
  }
}

/** Work through jobs that are due. Safe to run from several places at once (jobs are claimed, not shared). */
export async function runQueue(d: Deps, opts: { limit?: number } = {}): Promise<Tally> {
  const tally: Tally = { done: 0, waiting: 0, retrying: 0, failed: 0, cancelled: 0, mismatches: 0, stoppedForAuth: false };
  const jobs = await d.store.claimDue(nowOf(d), opts.limit ?? 25, STALE_RUNNING_MS);
  for (let i = 0; i < jobs.length; i++) {
    if (tally.stoppedForAuth) {
      // Give the rest of the claimed jobs back untouched.
      for (const rest of jobs.slice(i)) await d.store.updateJob(rest.id, { status: "pending", lockedAt: null }, nowOf(d));
      break;
    }
    await runOne(d, jobs[i], tally);
  }
  return tally;
}

/** Admin pressed Retry on a failed job: same RequestId, fresh attempts, due now. */
export async function retryJob(store: QboStore, id: string, now: Date = new Date()): Promise<boolean> {
  const j = await store.getJob(id);
  if (!j || j.status !== "failed") return false;
  await store.updateJob(id, { status: "pending", attempts: 0, nextAttemptAt: now, lockedAt: null }, now);
  return true;
}

/** Admin looked at a total mismatch and accepted it. */
export async function acknowledgeMismatch(store: QboStore, id: string, now: Date = new Date()): Promise<boolean> {
  const j = await store.getJob(id);
  if (!j || !j.mismatch) return false;
  await store.updateJob(id, { mismatch: false }, now);
  return true;
}

export type { CrmInvoice, CrmPayment };
