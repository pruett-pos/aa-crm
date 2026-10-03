import type { Role } from "../auth/roles.ts";
import { can } from "../auth/roles.ts";
import type { Division, Stage } from "../rules.ts";
import { normalizePhone, phoneSearchDigits } from "./phone.ts";
import { routeLead, type Market, type RouteResult } from "./routing.ts";
import {
  DIVISIONS, LEAD_SOURCES, MARKETS, type CustomerHit, type CustomerRow, type LeadJobType, type LeadSource,
  type LeadStore, type PropertyRow,
} from "./types.ts";

export type LeadErrorCode =
  | "not_found" | "name_invalid" | "contact_required" | "phone_invalid" | "email_invalid" | "address_invalid"
  | "market_invalid" | "job_type_invalid" | "division_invalid" | "source_invalid" | "appointment_invalid"
  | "estimator_invalid" | "not_in_review" | "query_too_short" | "month_invalid" | "amount_invalid" | "forbidden";

export class LeadError extends Error {
  code: LeadErrorCode;
  constructor(code: LeadErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/** CSRs and admins take calls and see customer contact details. */
export const canTakeLeads = (role: Role) => can(role, "createLeads");

// ---------- Validation helpers ----------
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (s: string | undefined | null, max: number) => (s ?? "").trim().replace(/\s+/g, " ").slice(0, max);

function validName(first: string, last: string) {
  if (!first || !last) throw new LeadError("name_invalid", "Enter a first and last name");
}
function validateDivisions(ds: string[]): Division[] {
  const unique = [...new Set(ds)];
  if (unique.length === 0 || unique.length > DIVISIONS.length || !unique.every((d) => (DIVISIONS as readonly string[]).includes(d))) {
    throw new LeadError("division_invalid");
  }
  return unique as Division[];
}
function validateMarket(m: string): Market {
  if (!(MARKETS as readonly string[]).includes(m)) throw new LeadError("market_invalid");
  return m as Market;
}
function validateAppointment(a: Date | null | undefined, now: Date): Date | null {
  if (!a) return null;
  const t = a.getTime();
  const day = 24 * 3600 * 1000;
  if (Number.isNaN(t) || t < now.getTime() - day || t > now.getTime() + 730 * day) throw new LeadError("appointment_invalid");
  return a;
}

export type NewPerson = { firstName: string; lastName: string; phone?: string; email?: string };
export type NewAddress = { street: string; city: string; state?: string; zip: string };

function readPerson(p: NewPerson) {
  const firstName = clean(p.firstName, 60), lastName = clean(p.lastName, 60);
  validName(firstName, lastName);
  const phoneRaw = clean(p.phone, 30);
  const phoneDigits = phoneRaw ? normalizePhone(phoneRaw) : null;
  if (phoneRaw && !phoneDigits) throw new LeadError("phone_invalid", "Enter a 10-digit phone number");
  const email = clean(p.email, 254).toLowerCase() || null;
  if (email && !EMAIL.test(email)) throw new LeadError("email_invalid");
  if (!phoneDigits && !email) throw new LeadError("contact_required", "Enter a phone number or an email");
  return { firstName, lastName, phone: phoneRaw || null, phoneDigits, email };
}
function readAddress(a: NewAddress) {
  const street = clean(a.street, 120), city = clean(a.city, 80), zip = clean(a.zip, 10);
  const state = (clean(a.state, 2) || "MO").toUpperCase();
  if (!street || !city || !/^\d{5}(-\d{4})?$/.test(zip) || !/^[A-Z]{2}$/.test(state)) throw new LeadError("address_invalid");
  return { street, city, state, zip: zip.slice(0, 5) };
}

// ---------- Search ----------
export async function searchCustomers(store: LeadStore, q: string): Promise<CustomerHit[]> {
  const text = clean(q, 80);
  const phoneDigits = phoneSearchDigits(text);
  if (!phoneDigits && text.replace(/\s/g, "").length < 3) throw new LeadError("query_too_short");
  return store.searchCustomers({ phoneDigits, text: phoneDigits ? null : text });
}

// ---------- Creating leads ----------
export type CreateLeadInput = {
  actorId: string;
  customer: { existingId: string } | NewPerson;
  property: { existingId: string } | NewAddress;
  market: string;
  jobType: string;
  divisions: string[];
  source: string;
  appointmentAt?: Date | null;
  overrideEstimatorId?: string | null;
};
export type CreateLeadResult = { jobId: string; jobNumber: number; customerId: string; route: RouteResult; reusedCustomer: boolean };

async function findOrCreateCustomerAndProperty(
  tx: Parameters<Parameters<LeadStore["transaction"]>[0]>[0], input: Pick<CreateLeadInput, "customer" | "property">, market: Market,
): Promise<{ customer: CustomerRow; property: PropertyRow; reused: boolean }> {
  let customer: CustomerRow | null;
  let reused = false;
  if ("existingId" in input.customer) {
    customer = await tx.getCustomer(input.customer.existingId);
    if (!customer) throw new LeadError("not_found", "Customer not found");
    reused = true;
  } else {
    const p = readPerson(input.customer);
    customer = p.phoneDigits ? await tx.findCustomerByPhone(p.phoneDigits) : null; // same phone = same customer
    if (customer) reused = true;
    else customer = await tx.createCustomer(p);
  }

  let property: PropertyRow | null;
  if ("existingId" in input.property) {
    property = await tx.getProperty(input.property.existingId);
    if (!property || property.customerId !== customer.id) throw new LeadError("not_found", "Property not found for this customer");
  } else {
    const a = readAddress(input.property);
    property = await tx.findPropertyByAddress(customer.id, a.street, a.zip);
    if (!property) property = await tx.createProperty({ customerId: customer.id, ...a, market });
  }
  return { customer, property, reused };
}

/** A CSR (or admin) takes a call: reuse or create the customer and property, create the job, route it. */
export async function createLead(store: LeadStore, input: CreateLeadInput, now: () => Date = () => new Date()): Promise<CreateLeadResult> {
  const market = validateMarket(input.market);
  if (input.jobType !== "retail" && input.jobType !== "insurance") throw new LeadError("job_type_invalid");
  const jobType = input.jobType as LeadJobType;
  const divisions = validateDivisions(input.divisions);
  if (!(LEAD_SOURCES as readonly string[]).includes(input.source)) throw new LeadError("source_invalid");
  const source = input.source as LeadSource;
  const appointmentAt = validateAppointment(input.appointmentAt, now());
  const override = input.overrideEstimatorId || null;
  if (override && !(await store.isActiveEstimator(override))) throw new LeadError("estimator_invalid");
  const pmRows = await store.getPmRows();

  return store.transaction(async (tx) => {
    const { customer, property, reused } = await findOrCreateCustomerAndProperty(tx, input, market);
    const route = routeLead({ lastEstimatorId: customer.lastEstimatorId, divisions, market, pmRows, overrideEstimatorId: override });
    const stage: Stage = appointmentAt ? "appointment_set" : "new_lead";
    const job = await tx.createJob({
      propertyId: property.id, jobType, divisions, stage, source, needsReview: false, appointmentAt,
      estimatorId: route.estimatorId, productionManagerId: route.productionManagerId, createdBy: input.actorId,
    });
    await tx.addHistory(job.id, null, stage, input.actorId);
    if (route.estimatorId) await tx.setLastEstimator(customer.id, route.estimatorId);
    return { jobId: job.id, jobNumber: job.jobNumber, customerId: customer.id, route, reusedCustomer: reused };
  });
}

// ---------- Website form ----------
export type WebsiteLeadInput = NewPerson & NewAddress & { division: string; message?: string };

/**
 * An online lead: no routing yet. The market is only a best guess (West Plains) and the lead waits in the
 * review queue until a CSR confirms it. Existing customers are matched by phone.
 */
export async function createWebsiteLead(store: LeadStore, input: WebsiteLeadInput): Promise<{ jobId: string; jobNumber: number }> {
  const divisions = validateDivisions([input.division]);
  const guessedMarket: Market = "west_plains";
  const message = clean(input.message, 1000);
  return store.transaction(async (tx) => {
    const { property } = await findOrCreateCustomerAndProperty(tx, { customer: input, property: input }, guessedMarket);
    const job = await tx.createJob({
      propertyId: property.id, jobType: "retail", divisions, stage: "new_lead", source: "website", needsReview: true,
      appointmentAt: null, estimatorId: null, productionManagerId: null, createdBy: null,
    });
    await tx.addHistory(job.id, null, "new_lead", null);
    await tx.logEvent("website_form", { jobId: job.id, message: message || null });
    return { jobId: job.id, jobNumber: job.jobNumber };
  });
}

// ---------- Confirming an online lead ----------
export async function confirmLead(
  store: LeadStore,
  a: { jobId: string; market: string; jobType?: string; divisions?: string[]; overrideEstimatorId?: string | null },
): Promise<{ route: RouteResult }> {
  const market = validateMarket(a.market);
  const override = a.overrideEstimatorId || null;
  if (override && !(await store.isActiveEstimator(override))) throw new LeadError("estimator_invalid");
  const pmRows = await store.getPmRows();
  return store.transaction(async (tx) => {
    const job = await tx.getReviewJob(a.jobId);
    if (!job) throw new LeadError("not_found");
    if (!job.needsReview) throw new LeadError("not_in_review", "This lead was already confirmed");
    const jobType = (a.jobType ?? "retail") as string;
    if (jobType !== "retail" && jobType !== "insurance") throw new LeadError("job_type_invalid");
    const divisions = validateDivisions(a.divisions ?? []);
    await tx.updatePropertyMarket(job.propertyId, market);
    const route = routeLead({ lastEstimatorId: job.lastEstimatorId, divisions, market, pmRows, overrideEstimatorId: override });
    await tx.updateReviewedJob(job.id, {
      jobType: jobType as LeadJobType, divisions, estimatorId: route.estimatorId, productionManagerId: route.productionManagerId,
    });
    if (route.estimatorId) await tx.setLastEstimator(job.customerId, route.estimatorId);
    return { route };
  });
}

// ---------- Ad spend ----------
/** Whole dollars and cents like "1,250.50", or "0". Never floats. */
export function parseSpendCents(input: string): number | null {
  const s = input.trim().replace(/^\$/, "");
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.replace(/,/g, "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= 100_000_000_00 ? cents : null; // up to $100M, zero allowed
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
export async function setMarketingSpend(
  store: LeadStore, a: { source: string; month: string; amountText: string }, now: () => Date = () => new Date(),
): Promise<{ source: LeadSource; month: string; spendCents: number }> {
  if (!(LEAD_SOURCES as readonly string[]).includes(a.source)) throw new LeadError("source_invalid");
  const m = MONTH.exec(a.month);
  if (!m) throw new LeadError("month_invalid");
  const monthIndex = Number(m[1]) * 12 + Number(m[2]) - 1;
  const n = now();
  const nowIndex = n.getUTCFullYear() * 12 + n.getUTCMonth();
  if (monthIndex < nowIndex - 60 || monthIndex > nowIndex + 12) throw new LeadError("month_invalid");
  const cents = parseSpendCents(a.amountText);
  if (cents === null) throw new LeadError("amount_invalid");
  await store.upsertSpend(a.source as LeadSource, a.month, cents);
  return { source: a.source as LeadSource, month: a.month, spendCents: cents };
}

export type { RouteResult };
