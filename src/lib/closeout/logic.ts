import { en } from "../../i18n/en.ts";
import { localDate } from "../commission/periods.ts";
import type { Actor } from "../production/types.ts";
import {
  INVOICE_TERMS_DAYS, addDays, balanceDueCents, invoiceGate, stageAfterPayment, type Division, type InvoiceGate,
} from "../rules.ts";
import { renderInvoicePdf, sha256Hex, type InvoiceData } from "./pdf.ts";
import { canManageInvoice, canViewInvoice, punchRights } from "./rights.ts";
import { starterItems } from "./template.ts";
import type { CloseoutStore, InvoiceRow } from "./types.ts";

export type CloseoutErrorCode =
  | "not_found" | "forbidden" | "wrong_stage" | "items_locked" | "item_not_found" | "label_invalid" | "too_many_items"
  | "division_not_on_job" | "no_contract" | "no_punchlist" | "punchlist_open" | "invoice_exists" | "no_invoice"
  | "reason_required" | "no_email" | "email_invalid" | "email_failed";

export class CloseoutError extends Error {
  code: CloseoutErrorCode;
  constructor(code: CloseoutErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

const MAX_ITEMS = 100;
const tradeLabel = (d: string) => (en.leads.divisionNames as Record<string, string>)[d] ?? d;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- View ----------
export type ItemView = {
  id: string; division: Division | null; labelEn: string; labelRu: string | null; done: boolean; doneAt: string | null;
  canTick: boolean; canEdit: boolean;
};
export type InvoiceView = {
  id: string; invoiceNumber: number; issuedAt: string; dueOn: string; contractCents: number; paidCents: number; balanceCents: number;
  status: "issued" | "void"; emailedTo: string | null; emailedAt: string | null; emailStatus: "sent" | "failed" | null;
  emailError: string | null; voidReason: string | null;
};
export type CloseoutView = {
  job: { id: string; jobNumber: number; stage: string; propertyAddress: string; customerName: string | null };
  items: ItemView[];
  progress: { done: number; total: number };
  /** True while the punchlist can still be changed (the job is in closeout and not yet invoiced). */
  editable: boolean;
  canStart: boolean;
  /** Where this person may add items: the whole job and/or particular trades. Null when they can't add any. */
  canAdd: { wholeJob: boolean; divisions: Division[] } | null;
  invoice: null | {
    canManage: boolean;
    live: InvoiceView | null;
    history: InvoiceView[];
    gate: InvoiceGate;
    contractCents: number; collectedCents: number; balanceCents: number;
    customerEmail: string | null;
  };
};

const toInvoiceView = (i: InvoiceRow): InvoiceView => ({
  id: i.id, invoiceNumber: i.invoiceNumber, issuedAt: i.issuedAt.toISOString(), dueOn: i.dueOn, contractCents: i.contractCents,
  paidCents: i.paidCents, balanceCents: i.balanceCents, status: i.status, emailedTo: i.emailedTo,
  emailedAt: i.emailedAt ? i.emailedAt.toISOString() : null, emailStatus: i.emailStatus, emailError: i.emailError, voidReason: i.voidReason,
});

export async function closeoutView(store: CloseoutStore, actor: Actor, jobId: string): Promise<CloseoutView> {
  const job = await store.getJob(jobId);
  if (!job) throw new CloseoutError("not_found");
  const [trades, pm, allItems] = await Promise.all([store.listTrades(jobId), store.pmDivisions(actor.id), store.listItems(jobId)]);
  const r = punchRights(actor, job, trades, pm);
  if (!r.canView) throw new CloseoutError("forbidden");

  const editable = job.stage === "closeout_punchlist";
  const items: ItemView[] = allItems.filter((i) => r.canSee(i.division)).map((i) => ({
    id: i.id, division: i.division, labelEn: i.labelEn, labelRu: i.labelRu, done: i.done, doneAt: i.doneAt ? i.doneAt.toISOString() : null,
    canTick: editable && r.canTick(i.division), canEdit: editable && r.canManage(i.division),
  }));

  let invoice: CloseoutView["invoice"] = null;
  if (canViewInvoice(actor, job, trades, pm)) {
    const [invoices, collected] = await Promise.all([store.listInvoices(jobId), store.collectedCents(jobId)]);
    const live = invoices.find((i) => i.status === "issued") ?? null;
    const contract = job.contractCents ?? 0;
    invoice = {
      canManage: canManageInvoice(actor),
      live: live ? toInvoiceView(live) : null,
      history: invoices.filter((i) => i.status === "void").map(toInvoiceView),
      gate: invoiceGate({ stage: job.stage, contractSigned: job.contractSigned, items: allItems, hasLiveInvoice: live !== null }),
      contractCents: contract, collectedCents: collected, balanceCents: balanceDueCents(contract, collected),
      customerEmail: job.customerEmail,
    };
  }

  const addable = { wholeJob: r.canManage(null), divisions: job.divisions.filter((d) => r.canManage(d)) };
  return {
    job: {
      id: job.id, jobNumber: job.jobNumber, stage: job.stage, propertyAddress: job.propertyAddress,
      customerName: actor.role === "crew_leader" ? null : job.customerName,       // crew screens never show the customer's name
    },
    items,
    progress: { done: allItems.filter((i) => i.done).length, total: allItems.length },
    editable,
    canStart: editable && allItems.length === 0 && r.canStart,
    canAdd: editable && (addable.wholeJob || addable.divisions.length > 0) ? addable : null,
    invoice,
  };
}

// ---------- Punchlist ----------

/** Build the starting list, once, for a job in closeout. */
export async function startPunchlist(store: CloseoutStore, actor: Actor, jobId: string): Promise<{ created: number }> {
  const pm = await store.pmDivisions(actor.id);
  return store.transaction(jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new CloseoutError("not_found");
    const r = punchRights(actor, job, await tx.listTrades(), pm);
    if (!r.canStart) throw new CloseoutError("forbidden");
    if (job.stage !== "closeout_punchlist") throw new CloseoutError(job.stage === "invoiced" || job.stage === "paid_in_full" ? "items_locked" : "wrong_stage");
    if ((await tx.listItems()).length > 0) return { created: 0 };
    const items = starterItems(job.divisions);
    await tx.insertItems(items, actor.id);
    return { created: items.length };
  });
}

const cleanLabel = (s: unknown): string => {
  const t = typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (t.length < 1 || t.length > 200) throw new CloseoutError("label_invalid");
  return t;
};
const cleanOptional = (s: unknown): string | null => {
  if (s === undefined || s === null || s === "") return null;
  return cleanLabel(s);
};

export async function setItemDone(store: CloseoutStore, actor: Actor, jobId: string, itemId: string, done: boolean, now: () => Date = () => new Date()): Promise<void> {
  const pm = await store.pmDivisions(actor.id);
  await store.transaction(jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new CloseoutError("not_found");
    const r = punchRights(actor, job, await tx.listTrades(), pm);
    const item = (await tx.listItems()).find((i) => i.id === itemId);
    // Someone who may not see an item is told it doesn't exist, rather than that it does.
    if (!item || !r.canSee(item.division)) throw new CloseoutError("item_not_found");
    if (!r.canTick(item.division)) throw new CloseoutError("forbidden");
    if (job.stage !== "closeout_punchlist") throw new CloseoutError("items_locked");
    if (item.done === done) return;
    await tx.updateItem(itemId, { done }, actor.id, now());
  });
}

export async function addItem(
  store: CloseoutStore, actor: Actor, jobId: string, input: { division: Division | null; labelEn: unknown; labelRu?: unknown },
): Promise<void> {
  const labelEn = cleanLabel(input.labelEn);
  const labelRu = cleanOptional(input.labelRu);
  const pm = await store.pmDivisions(actor.id);
  await store.transaction(jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new CloseoutError("not_found");
    const r = punchRights(actor, job, await tx.listTrades(), pm);
    if (!r.canView) throw new CloseoutError("forbidden");
    if (input.division !== null && !job.divisions.includes(input.division)) throw new CloseoutError("division_not_on_job");
    if (!r.canManage(input.division)) throw new CloseoutError("forbidden");
    if (job.stage !== "closeout_punchlist") throw new CloseoutError(job.stage === "invoiced" || job.stage === "paid_in_full" ? "items_locked" : "wrong_stage");
    if ((await tx.listItems()).length >= MAX_ITEMS) throw new CloseoutError("too_many_items");
    await tx.insertItems([{ division: input.division, labelEn, labelRu }], actor.id);
  });
}

export async function editItem(
  store: CloseoutStore, actor: Actor, jobId: string, itemId: string, input: { labelEn?: unknown; labelRu?: unknown },
): Promise<void> {
  const patch: { labelEn?: string; labelRu?: string | null } = {};
  if (input.labelEn !== undefined) patch.labelEn = cleanLabel(input.labelEn);
  if (input.labelRu !== undefined) patch.labelRu = cleanOptional(input.labelRu);
  const pm = await store.pmDivisions(actor.id);
  await store.transaction(jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new CloseoutError("not_found");
    const r = punchRights(actor, job, await tx.listTrades(), pm);
    const item = (await tx.listItems()).find((i) => i.id === itemId);
    if (!item || !r.canSee(item.division)) throw new CloseoutError("item_not_found");
    if (!r.canManage(item.division)) throw new CloseoutError("forbidden");
    if (job.stage !== "closeout_punchlist") throw new CloseoutError("items_locked");
    await tx.updateItem(itemId, patch, actor.id, new Date());
  });
}

export async function removeItem(store: CloseoutStore, actor: Actor, jobId: string, itemId: string): Promise<void> {
  const pm = await store.pmDivisions(actor.id);
  await store.transaction(jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new CloseoutError("not_found");
    const r = punchRights(actor, job, await tx.listTrades(), pm);
    const item = (await tx.listItems()).find((i) => i.id === itemId);
    if (!item || !r.canSee(item.division)) throw new CloseoutError("item_not_found");
    if (!r.canManage(item.division)) throw new CloseoutError("forbidden");
    if (job.stage !== "closeout_punchlist") throw new CloseoutError("items_locked");
    await tx.deleteItem(itemId);
  });
}

// ---------- Invoice ----------
const GATE_CODE = {
  wrong_stage: "wrong_stage", no_contract: "no_contract", no_punchlist: "no_punchlist",
  punchlist_open: "punchlist_open", invoice_exists: "invoice_exists",
} as const;

/** Issue the job's invoice: a frozen snapshot of the contract total, what has been paid, and the balance. */
export async function issueInvoice(
  store: CloseoutStore, actor: Actor, jobId: string, now: () => Date = () => new Date(),
): Promise<{ invoice: InvoiceRow; stage: string }> {
  if (!canManageInvoice(actor)) throw new CloseoutError("forbidden");
  return store.transaction(jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new CloseoutError("not_found");
    const items = await tx.listItems();
    const live = await tx.liveInvoice();
    const gate = invoiceGate({ stage: job.stage, contractSigned: job.contractSigned && !!job.contractCents, items, hasLiveInvoice: live !== null });
    if (!gate.ok) throw new CloseoutError(GATE_CODE[gate.reason]);

    const at = now();
    const contract = job.contractCents ?? 0;
    const collected = await tx.collectedCents();
    const balance = balanceDueCents(contract, collected);
    const issuedOn = localDate(at);
    const dueOn = addDays(issuedOn, INVOICE_TERMS_DAYS);
    const invoiceNumber = await tx.nextInvoiceNumber();
    const data: InvoiceData = {
      invoiceNumber, jobNumber: job.jobNumber, customerName: job.customerName, propertyAddress: job.propertyAddress, issuedOn, dueOn,
      sections: (await tx.chosenSections()).map((s) => ({ divisionLabel: tradeLabel(s.division), packageTitle: s.packageTitle, subtotalCents: s.subtotalCents })),
      contractCents: contract, paidCents: collected, balanceCents: balance,
    };
    const pdf = await renderInvoicePdf(data);
    const invoice = await tx.insertInvoice({
      invoiceNumber, dueOn, contractCents: contract, paidCents: collected, balanceCents: balance, issuedBy: actor.id, issuedAt: at,
      pdf, pdfSha256: sha256Hex(pdf),
    });

    let stage = job.stage as string;
    if (job.stage === "closeout_punchlist") {
      await tx.setStage("closeout_punchlist", "invoiced", actor.id);
      stage = "invoiced";
    }
    const paid = stageAfterPayment(stage, balance);   // nothing owed: straight on to paid in full
    if (paid) {
      await tx.setStage("invoiced", paid, actor.id);
      stage = paid;
    }
    return { invoice, stage };
  });
}

export type SendInvoiceEmail = (a: { to: string; customerName: string; invoiceNumber: number; jobNumber: number; balanceCents: number; pdf: Uint8Array }) => Promise<void>;

/**
 * Email the live invoice. The result is recorded separately from issuing, so a failed email never loses the invoice
 * and can simply be sent again.
 */
export async function sendInvoice(
  store: CloseoutStore, actor: Actor, jobId: string, input: { to?: string | null }, send: SendInvoiceEmail, now: () => Date = () => new Date(),
): Promise<{ to: string }> {
  if (!canManageInvoice(actor)) throw new CloseoutError("forbidden");
  const job = await store.getJob(jobId);
  if (!job) throw new CloseoutError("not_found");
  const live = (await store.listInvoices(jobId)).find((i) => i.status === "issued");
  if (!live) throw new CloseoutError("no_invoice");
  const to = (input.to?.trim() || job.customerEmail || "").trim();
  if (!to) throw new CloseoutError("no_email");
  if (to.length > 254 || !EMAIL.test(to)) throw new CloseoutError("email_invalid");
  const pdf = await store.getInvoicePdf(live.id);
  if (!pdf) throw new CloseoutError("no_invoice");
  try {
    await send({ to, customerName: job.customerName, invoiceNumber: live.invoiceNumber, jobNumber: job.jobNumber, balanceCents: live.balanceCents, pdf });
  } catch {
    await store.recordEmail(live.id, { to, status: "failed", error: "The email could not be sent", at: now() });
    throw new CloseoutError("email_failed");
  }
  await store.recordEmail(live.id, { to, status: "sent", error: null, at: now() });
  return { to };
}

/** Void a mistaken invoice (reason required). The job's stage stays put; a new invoice can then be issued. */
export async function voidInvoice(store: CloseoutStore, actor: Actor, jobId: string, reason: string, now: () => Date = () => new Date()): Promise<void> {
  if (!canManageInvoice(actor)) throw new CloseoutError("forbidden");
  const why = reason.trim();
  if (why.length < 3 || why.length > 300) throw new CloseoutError("reason_required");
  await store.transaction(jobId, async (tx) => {
    const job = await tx.getJob();
    if (!job) throw new CloseoutError("not_found");
    const live = await tx.liveInvoice();
    if (!live) throw new CloseoutError("no_invoice");
    // A job that is already paid in full has nothing left to correct on its invoice.
    if (job.stage !== "invoiced") throw new CloseoutError("wrong_stage");
    if (!(await tx.voidInvoice(live.id, actor.id, why, now()))) throw new CloseoutError("no_invoice");
  });
}

/** The invoice PDF, for whoever may view the job's invoice. */
export async function invoicePdfFor(store: CloseoutStore, actor: Actor, invoiceId: string): Promise<{ pdf: Uint8Array; filename: string }> {
  const inv = await store.getInvoice(invoiceId);
  if (!inv) throw new CloseoutError("not_found");
  const job = await store.getJob(inv.jobId);
  if (!job) throw new CloseoutError("not_found");
  const [trades, pm] = await Promise.all([store.listTrades(inv.jobId), store.pmDivisions(actor.id)]);
  if (!canViewInvoice(actor, job, trades, pm)) throw new CloseoutError("not_found");   // not even confirmed to exist
  const pdf = await store.getInvoicePdf(inv.id);
  if (!pdf) throw new CloseoutError("not_found");
  return { pdf, filename: `invoice-${inv.invoiceNumber}.pdf` };
}
