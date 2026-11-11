import { test } from "node:test";
import assert from "node:assert/strict";
import { QboError } from "../src/integrations/quickbooks/errors.ts";
import { centsToDollars, createQboClient, dollarsToCents, qboQuote, type NewQboCustomer, type NewQboInvoice, type NewQboPayment, type QboClient, type QboCustomer, type QboInvoiceInfo } from "../src/integrations/quickbooks/client.ts";
import { exchangeQboCode, qboApiBase, qboAuthorizeUrl, qboConfigFromEnv, qboStateMatches, refreshQboTokens, type QboConfig } from "../src/integrations/quickbooks/oauth.ts";
import { MemoryQboStore } from "../src/lib/quickbooks/memory-store.ts";
import { MemoryQboTokenStore } from "../src/lib/quickbooks/memory-token-store.ts";
import { createQboTokenProvider } from "../src/lib/quickbooks/tokens.ts";
import { MAX_ATTEMPTS, acknowledgeMismatch, backoffMs, dismissDuplicateFlag, enqueueInvoice, linkToExistingCustomer, matchQboCustomer, retryJob, runQueue, sweep } from "../src/lib/quickbooks/logic.ts";
import type { CrmCustomer, CrmInvoice, CrmPayment } from "../src/lib/quickbooks/types.ts";

// ---------- OAuth ----------
const CFG: QboConfig = { clientId: "cid-1", clientSecret: "secret-xyz", redirectUri: "http://localhost:3000/api/quickbooks/callback", environment: "sandbox" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const T0 = new Date("2026-11-10T15:00:00Z");

test("config: needs all three keys, defaults to sandbox, rejects a mistyped environment", () => {
  const env = { QBO_CLIENT_ID: "a", QBO_CLIENT_SECRET: "b", QBO_REDIRECT_URI: "http://x/api/quickbooks/callback" };
  assert.equal(qboConfigFromEnv(env)?.environment, "sandbox");
  assert.equal(qboConfigFromEnv({ ...env, QBO_ENVIRONMENT: "Production" })?.environment, "production");
  assert.equal(qboConfigFromEnv({ ...env, QBO_ENVIRONMENT: "prod" }), null);
  assert.equal(qboConfigFromEnv({ ...env, QBO_CLIENT_SECRET: "" }), null);
  assert.equal(qboApiBase("sandbox"), "https://sandbox-quickbooks.api.intuit.com");
  assert.equal(qboApiBase("production"), "https://quickbooks.api.intuit.com");
});

test("authorize URL: accounting scope, exact redirect, state", () => {
  const u = new URL(qboAuthorizeUrl(CFG, "st8"));
  assert.equal(u.origin + u.pathname, "https://appcenter.intuit.com/connect/oauth2");
  assert.equal(u.searchParams.get("scope"), "com.intuit.quickbooks.accounting");
  assert.equal(u.searchParams.get("redirect_uri"), CFG.redirectUri);
  assert.equal(u.searchParams.get("state"), "st8");
  assert.equal(u.searchParams.get("response_type"), "code");
});

test("OAuth state: must equal the cookie; missing or different is refused", () => {
  assert.equal(qboStateMatches("abc123", "abc123"), true);
  assert.equal(qboStateMatches("abc123", "abc124"), false);
  assert.equal(qboStateMatches("abc123", null), false);
  assert.equal(qboStateMatches("", "abc123"), false);
  assert.equal(qboStateMatches("abc", "abcd"), false);
});

test("code exchange: Basic auth header, form body, realm kept, expiry computed; refusal is an auth error", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const ok = async (url: string, init?: RequestInit) => { seen = { url, init: init ?? {} }; return json({ access_token: "acc1", refresh_token: "ref1", expires_in: 3600, x_refresh_token_expires_in: 8726400 }); };
  const t = await exchangeQboCode(CFG, "the-code", "9130", ok, T0);
  assert.deepEqual([t.accessToken, t.refreshToken, t.realmId], ["acc1", "ref1", "9130"]);
  assert.equal(t.expiresAt.getTime(), T0.getTime() + 3600_000);
  assert.equal(seen!.url, "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer");
  assert.equal((seen!.init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("cid-1:secret-xyz").toString("base64")}`);
  const body = new URLSearchParams(String(seen!.init.body));
  assert.deepEqual([body.get("grant_type"), body.get("code"), body.get("redirect_uri")], ["authorization_code", "the-code", CFG.redirectUri]);
  await assert.rejects(() => exchangeQboCode(CFG, "bad", "9130", async () => json({ error: "invalid_grant" }, 400), T0), (e: QboError) => e.kind === "auth" && !/secret|invalid_grant/.test(e.message));
});

// ---------- token refresh ----------
const tokenBody = (n: number) => ({ access_token: `acc${n}`, refresh_token: `ref${n}`, expires_in: 3600 });
async function connected(expiresInMs: number) {
  const store = new MemoryQboTokenStore();
  await store.connect({ accessToken: "acc0", refreshToken: "ref0", expiresAt: new Date(T0.getTime() + expiresInMs), realmId: "9130" }, "user-1");
  return store;
}

test("token refresh: a fresh token is reused; an expiring one is refreshed once and the new refresh token is saved", async () => {
  const store = await connected(30 * 60_000);
  let calls = 0;
  const get = createQboTokenProvider({ store, config: CFG, fetch: async () => { calls++; return json(tokenBody(1)); }, now: () => T0 });
  assert.equal(await get(false), "acc0");
  assert.equal(calls, 0);
  assert.equal(await get(true), "acc1");                        // forced (after a 401)
  assert.equal(store.row?.refreshToken, "ref1");
  assert.equal(store.row?.realmId, "9130");

  const soon = await connected(60_000);                          // inside the 2-minute skew
  let n = 0;
  const get2 = createQboTokenProvider({ store: soon, config: CFG, fetch: async () => { n++; await new Promise((r) => setTimeout(r, 5)); return json(tokenBody(7)); }, now: () => T0 });
  const results = await Promise.all([get2(false), get2(false), get2(false)]);
  assert.deepEqual(results, ["acc7", "acc7", "acc7"]);
  assert.equal(n, 1);                                            // three callers, one refresh
});

test("token refresh: the refresh request sends the refresh token; a refused one marks needs-reconnect and is not retried", async () => {
  const store = await connected(10_000);
  let calls = 0, body = "";
  const get = createQboTokenProvider({ store, config: CFG, fetch: async (_u, i) => { calls++; body = String(i?.body); return json({ error: "invalid_grant" }, 400); }, now: () => T0 });
  await assert.rejects(() => get(false), (e: QboError) => e.kind === "auth");
  assert.equal(new URLSearchParams(body).get("refresh_token"), "ref0");
  assert.equal(store.row?.status, "needs_reconnect");
  await assert.rejects(() => get(false), /connected again/);
  assert.equal(calls, 1);
  const t = await refreshQboTokens(CFG, "ref", "9130", async () => json(tokenBody(2)), T0);
  assert.equal(t.refreshToken, "ref2");
});

// ---------- REST client (fake Intuit server) ----------
test("client: query and create URLs, bearer token, RequestId, dollars from cents, 401 refreshes once", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let tokenCalls: boolean[] = [];
  let first = true;
  const f = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (first) { first = false; return new Response("{}", { status: 401 }); }
    return json({ Invoice: { Id: "77", TotalAmt: 1234.56, DocNumber: "1001", CustomerRef: { value: "5" } } });
  };
  const c = createQboClient({ apiBase: "https://sandbox-quickbooks.api.intuit.com", realmId: "9130", getAccessToken: async (force) => { tokenCalls.push(force); return force ? "new" : "old"; }, fetch: f });
  const inv = await c.createInvoice({
    requestId: "req-1", customerId: "5", classId: "9", docNumber: "1001", txnDate: "2026-11-10", dueDate: "2026-11-10", memo: "m",
    address: { line1: "1 Main", city: "West Plains", state: "MO", postalCode: "65775" },
    lines: [{ itemId: "3", description: "Better", amountCents: 123456 }],
  });
  assert.deepEqual(tokenCalls, [false, true]);
  assert.equal(inv.totalCents, 123456);
  const u = new URL(calls[1].url);
  assert.equal(u.origin + u.pathname, "https://sandbox-quickbooks.api.intuit.com/v3/company/9130/invoice");
  assert.equal(u.searchParams.get("requestid"), "req-1");
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, "Bearer new");
  const body = JSON.parse(String(calls[1].init.body));
  assert.equal(body.Line[0].Amount, 1234.56);
  assert.equal(body.ClassRef.value, "9");
  assert.equal(body.DocNumber, "1001");
});

test("client: errors are classified, and Intuit's reason is kept without request data", async () => {
  const mk = (res: () => Response) => createQboClient({ apiBase: "https://x", realmId: "1", getAccessToken: async () => "t", fetch: async () => res() });
  await assert.rejects(() => mk(() => json({ Fault: { Error: [{ Message: "Duplicate Name Exists Error", Detail: "The name supplied already exists", code: "6240" }] } }, 400)).findClassByName("a"), (e: QboError) => e.kind === "duplicate" && /already exists/.test(e.message));
  await assert.rejects(() => mk(() => json({ Fault: { Error: [{ Message: "Invalid reference", code: "2500" }] } }, 400)).findClassByName("a"), (e: QboError) => e.kind === "validation");
  await assert.rejects(() => mk(() => new Response("", { status: 503 })).findClassByName("a"), (e: QboError) => e.kind === "server");
  await assert.rejects(() => mk(() => new Response("", { status: 429 })).findClassByName("a"), (e: QboError) => e.kind === "rate_limit");
  await assert.rejects(() => createQboClient({ apiBase: "https://x", realmId: "1", getAccessToken: async () => "t", fetch: async () => { throw new Error("boom"); } }).findClassByName("a"), (e: QboError) => e.kind === "network");
});

test("money conversion and query quoting", () => {
  assert.equal(centsToDollars(1999), 19.99);
  assert.equal(centsToDollars(100000007), 1000000.07);
  assert.equal(dollarsToCents(19.99), 1999);
  assert.equal(dollarsToCents("0.29"), 29);          // 0.29 * 100 is 28.999999999999996 in floating point
  assert.equal(qboQuote("O'Brien \\ Sons"), "'O\\'Brien \\\\ Sons'");
});

// ---------- a fake QuickBooks for the engine ----------
class FakeQbo implements QboClient {
  customers: (QboCustomer & { requestId?: string })[] = [];
  classes = new Map<string, string>();
  items = new Map<string, string>();
  methods = new Map<string, string>();
  invoices: (QboInvoiceInfo & { requestId: string; lines: NewQboInvoice["lines"]; classId: string; dueDate: string })[] = [];
  payments: (NewQboPayment & { id: string; voided: boolean })[] = [];
  calls: string[] = [];
  failNext: QboError[] = [];
  /** Added to every invoice total (tests a sales tax setting in QuickBooks). */
  taxCents = 0;
  duplicateNameOnce = false;
  private n = 100;
  private id = () => String(++this.n);
  private maybeFail() { const e = this.failNext.shift(); if (e) throw e; }

  async companyName() { return "A&A Quality Roofing"; }
  async findCustomers(q: { email?: string | null; displayName?: string | null }) {
    this.calls.push("findCustomers");
    return this.customers.filter((c) => (q.email && c.email?.toLowerCase() === q.email.toLowerCase()) || (q.displayName && c.displayName.toLowerCase() === q.displayName.toLowerCase()));
  }
  async createCustomer(c: NewQboCustomer) {
    this.calls.push("createCustomer"); this.maybeFail();
    if (this.duplicateNameOnce) { this.duplicateNameOnce = false; throw new QboError("duplicate", "Duplicate Name Exists Error"); }
    const dup = this.customers.find((x) => x.requestId === c.requestId);
    if (dup) return { id: dup.id };
    // QuickBooks display names are unique.
    if (this.customers.some((x) => x.displayName.toLowerCase() === c.displayName.toLowerCase())) throw new QboError("duplicate", "Duplicate Name Exists Error");
    const id = this.id();
    this.customers.push({ id, displayName: c.displayName, givenName: c.givenName, familyName: c.familyName, email: c.email, phone: c.phone,
      address: c.address ? { line1: c.address.line1, postalCode: c.address.postalCode } : null, requestId: c.requestId });
    return { id };
  }
  async findClassByName(n: string) { return this.classes.get(n) ?? null; }
  async createClass(n: string) { this.calls.push(`createClass:${n}`); const id = this.id(); this.classes.set(n, id); return id; }
  async findItemByName(n: string) { return this.items.get(n) ?? null; }
  async findIncomeAccountId() { return "inc-1"; }
  async createServiceItem(n: string) { this.calls.push(`createItem:${n}`); const id = this.id(); this.items.set(n, id); return id; }
  async findPaymentMethodByName(n: string) { return this.methods.get(n) ?? null; }
  async createPaymentMethod(n: string) { this.calls.push(`createMethod:${n}`); const id = this.id(); this.methods.set(n, id); return id; }
  async findInvoiceByDocNumber(d: string) { return this.invoices.find((i) => i.docNumber === d && !i.voided) ?? null; }
  async createInvoice(i: NewQboInvoice) {
    this.calls.push("createInvoice"); this.maybeFail();
    const dup = this.invoices.find((x) => x.requestId === i.requestId);
    if (dup) return dup;
    const rec = { id: this.id(), customerId: i.customerId, docNumber: i.docNumber, voided: false, requestId: i.requestId, lines: i.lines, classId: i.classId, dueDate: i.dueDate,
      totalCents: i.lines.reduce((s, l) => s + l.amountCents, 0) + this.taxCents };
    this.invoices.push(rec);
    return rec;
  }
  async createPayment(p: NewQboPayment) {
    this.calls.push("createPayment"); this.maybeFail();
    const dup = this.payments.find((x) => x.requestId === p.requestId);
    if (dup) return { id: dup.id, totalCents: dup.amountCents };
    const rec = { ...p, id: this.id(), voided: false };
    this.payments.push(rec);
    return { id: rec.id, totalCents: p.amountCents };
  }
  async voidInvoice(id: string) {
    this.calls.push("voidInvoice"); this.maybeFail();
    if (this.payments.some((p) => !p.voided && p.invoiceId === id)) throw new QboError("validation", "Invoice has payments applied");
    const i = this.invoices.find((x) => x.id === id); if (i) i.voided = true;
  }
  async voidPayment(id: string) { this.calls.push("voidPayment"); this.maybeFail(); const p = this.payments.find((x) => x.id === id); if (p) p.voided = true; }
}

const qc = (over: Partial<QboCustomer> & { id: string }): QboCustomer =>
  ({ displayName: "Dana Miller", givenName: "Dana", familyName: "Miller", email: null, phone: null, address: null, ...over });
const CUST: CrmCustomer = { id: "00000000-0000-4000-8000-000000000c01", firstName: "Dana", lastName: "Miller", email: "dana@example.com", phone: "(417) 555-0123" };
const PROP = { street: "100 Example Rd", city: "West Plains", state: "MO", zip: "65775" };
const INV_ID = "00000000-0000-4000-8000-0000000000a1";
const JOB_ID = "00000000-0000-4000-8000-0000000000b1";
const mkInvoice = (over: Partial<CrmInvoice> = {}): CrmInvoice => ({
  id: INV_ID, jobId: JOB_ID, jobNumber: 4001, invoiceNumber: 1001, issuedAt: T0, dueOn: "2026-11-10", contractCents: 1_500_000, status: "issued",
  source: "demandiq", customer: CUST, property: PROP, ...over,
});
const mkPayment = (id: string, over: Partial<CrmPayment> = {}): CrmPayment => ({
  id, jobId: JOB_ID, jobNumber: 4001, amountCents: 500_000, method: "check", reference: "1042", isDeposit: false, receivedAt: T0, voidedAt: null, customer: CUST, ...over,
});
const PAY1 = "00000000-0000-4000-8000-0000000000d1";
const PAY2 = "00000000-0000-4000-8000-0000000000d2";

async function setup(opts: { syncFrom?: Date } = {}) {
  const store = new MemoryQboStore();
  await store.saveConnection({ realmId: "9130", companyName: "A&A", environment: "sandbox" }, opts.syncFrom ?? new Date(T0.getTime() - 86_400_000));
  const client = new FakeQbo();
  let now = T0;
  const deps = { store, client, now: () => now };
  return { store, client, deps, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, clock: () => now };
}
function addInvoice(store: MemoryQboStore, over: Partial<CrmInvoice> = {}, lines?: { division: "roofing" | "siding" | "gutters"; description: string; amountCents: number }[]) {
  const inv = mkInvoice(over);
  store.invoices.push(inv);
  store.invoiceLineRows.set(inv.id, lines ?? [{ division: "roofing", description: "Better roof package", amountCents: 1_000_000 }, { division: "gutters", description: "Good gutter package", amountCents: 500_000 }]);
  return inv;
}

// ---------- customer match vs create ----------
// Same person = the NAME matches AND (the email OR the street + zip matches). Name alone is never enough.
async function runInvoice(over: Awaited<ReturnType<typeof setup>>) {
  addInvoice(over.store);
  await enqueueInvoice(over.store, INV_ID, T0);
  return runQueue(over.deps);
}

test("customer: name + email match reuses the QuickBooks customer (case and spacing ignored) and stores its id", async () => {
  const x = await setup();
  x.client.customers.push(qc({ id: "55", displayName: "  DANA   miller ", email: "Dana@Example.com" }));
  assert.equal((await runInvoice(x)).done, 1);
  assert.ok(!x.client.calls.includes("createCustomer"));
  assert.equal(x.client.invoices[0].customerId, "55");
  assert.equal((await x.store.getLink("customer", CUST.id))?.qboId, "55");
  assert.equal((await x.store.listDuplicateFlags("open")).length, 0);
});

test("customer: name + address match (street and zip, punctuation and case ignored) reuses it even with a different email or none", async () => {
  const x = await setup();
  x.client.customers.push(qc({ id: "56", email: "someone.else@example.com", address: { line1: "100 EXAMPLE rd.", postalCode: "65775-1234" } }));
  assert.equal((await runInvoice(x)).done, 1);
  assert.equal(x.client.invoices[0].customerId, "56");
  assert.ok(!x.client.calls.includes("createCustomer"));
  assert.equal((await x.store.listDuplicateFlags("open")).length, 0);
});

test("customer: name + email OR address together may also match a different spelling of the name (given + family)", async () => {
  const x = await setup();
  x.client.customers.push(qc({ id: "58", displayName: "Miller Roofing Co", email: "dana@example.com" }));   // display name differs: given + family still match
  assert.equal((await runInvoice(x)).done, 1);
  assert.equal(x.client.invoices[0].customerId, "58");
});

test("customer: email alone is NOT a match when the name differs, and a street without the same zip is not an address match", async () => {
  const x = await setup();
  x.client.customers.push(qc({ id: "59", displayName: "Pat Jones", givenName: "Pat", familyName: "Jones", email: "dana@example.com" }));
  x.client.customers.push(qc({ id: "60", address: { line1: "100 Example Rd", postalCode: "65801" } }));          // right name and street, wrong zip
  await runInvoice(x);
  assert.equal(x.client.calls.filter((c) => c === "createCustomer").length, 2);                      // the first create hits the duplicate name, the retry succeeds
  assert.notEqual(x.client.invoices[0].customerId, "59");
  assert.notEqual(x.client.invoices[0].customerId, "60");
});

test("customer: name only -> a NEW QuickBooks customer is created and flagged as a possible duplicate", async () => {
  const x = await setup();
  x.client.customers.push(qc({ id: "57", email: "other@example.com", address: { line1: "9 Elm St", postalCode: "65775" } }));
  const t = await runInvoice(x);
  assert.equal(t.done, 1);
  const created = x.client.customers.find((c) => c.id !== "57")!;
  assert.equal(created.displayName, "Dana Miller (00000000)");                       // QuickBooks names are unique, so ours is made distinct
  assert.equal(created.email, "dana@example.com");
  assert.deepEqual(created.address, { line1: "100 Example Rd", postalCode: "65775" });   // saved so the next match can use it
  assert.equal(x.client.invoices[0].customerId, created.id);                        // never silently attached to the existing one
  const flags = await x.store.listDuplicateFlags("open");
  assert.equal(flags.length, 1);
  assert.deepEqual([flags[0].customerId, flags[0].customerName, flags[0].createdQboId], [CUST.id, "Dana Miller", created.id]);
  assert.deepEqual(flags[0].candidates, [{ id: "57", displayName: "Dana Miller", email: "other@example.com" }]);
});

test("customer: nothing matches -> created without a flag, with phone formatted", async () => {
  const x = await setup();
  await runInvoice(x);
  assert.equal(x.client.calls.filter((c) => c === "createCustomer").length, 1);
  assert.equal(x.client.customers[0].displayName, "Dana Miller");
  assert.equal(x.client.customers[0].phone, "417-555-0123");
  assert.equal((await x.store.listDuplicateFlags("open")).length, 0);
});

test("customer: linking a flagged customer to the existing QuickBooks one sends future pushes there and closes the flag", async () => {
  const x = await setup();
  x.client.customers.push(qc({ id: "57", email: "other@example.com" }));
  await runInvoice(x);
  const created = x.client.customers.find((c) => c.id !== "57")!;
  assert.equal((await x.store.getLink("customer", CUST.id))?.qboId, created.id);

  assert.equal(await linkToExistingCustomer(x.store, CUST.id, "999"), false);        // not one of the candidates QuickBooks showed
  assert.equal(await linkToExistingCustomer(x.store, "00000000-0000-4000-8000-0000000000ff", "57"), false);
  assert.equal(await linkToExistingCustomer(x.store, CUST.id, "57"), true);
  assert.equal((await x.store.getLink("customer", CUST.id))?.qboId, "57");
  assert.equal((await x.store.listDuplicateFlags("open")).length, 0);
  assert.equal((await x.store.getDuplicateFlag(CUST.id))?.status, "linked");
  assert.equal(await linkToExistingCustomer(x.store, CUST.id, "57"), false);         // already resolved

  // the next invoice for this customer goes to the linked QuickBooks customer
  const INV2 = "00000000-0000-4000-8000-0000000000a3";
  addInvoice(x.store, { id: INV2, invoiceNumber: 1003, jobId: "00000000-0000-4000-8000-0000000000b2" });
  await enqueueInvoice(x.store, INV2, T0);
  await runQueue(x.deps);
  assert.equal(x.client.invoices.find((i) => i.docNumber === "1003")?.customerId, "57");
});

test("customer: dismissing a flag keeps the new customer and closes the flag", async () => {
  const x = await setup();
  x.client.customers.push(qc({ id: "57", email: "other@example.com" }));
  await runInvoice(x);
  const created = (await x.store.getLink("customer", CUST.id))!.qboId;
  assert.equal(await dismissDuplicateFlag(x.store, CUST.id), true);
  assert.equal((await x.store.getLink("customer", CUST.id))?.qboId, created);
  assert.equal((await x.store.listDuplicateFlags("open")).length, 0);
  assert.equal(await dismissDuplicateFlag(x.store, CUST.id), false);
});

test("matchQboCustomer: pure rules", () => {
  const addr = { street: "100 Example Rd", city: "West Plains", state: "MO", zip: "65775" };
  const noEmail = { ...CUST, email: null };
  assert.equal(matchQboCustomer(noEmail, addr, [qc({ id: "1" })]).match, null);                                   // name only
  assert.equal(matchQboCustomer(noEmail, addr, [qc({ id: "1" })]).possible.length, 1);
  assert.equal(matchQboCustomer(noEmail, null, [qc({ id: "1", address: { line1: "100 Example Rd", postalCode: "65775" } })]).match, null);   // no CRM address to compare
  assert.equal(matchQboCustomer(CUST, addr, [qc({ id: "1", email: "DANA@example.com" })]).match?.id, "1");
  assert.equal(matchQboCustomer(CUST, addr, [qc({ id: "1", displayName: "Someone Else", givenName: "Someone", familyName: "Else", email: "dana@example.com" })]).match, null);
  assert.equal(matchQboCustomer(CUST, addr, [qc({ id: "1", address: { line1: "100  Example Rd.", postalCode: "65775" } }), qc({ id: "2", email: "dana@example.com" })]).match?.id, "2");   // email beats address
});

test("customer: a name already taken by someone else gets a distinct name instead of failing", async () => {
  const { store, client, deps } = await setup();
  client.duplicateNameOnce = true;
  addInvoice(store); await enqueueInvoice(store, INV_ID, T0);
  assert.equal((await runQueue(deps)).done, 1);
  assert.match(client.customers[0].displayName, /^Dana Miller \(00000000\)$/);
});

// ---------- invoice, class, items ----------
test("invoice: line per trade, number, due date, lead source class and division items are created when missing", async () => {
  const { store, client, deps } = await setup();
  addInvoice(store);
  await enqueueInvoice(store, INV_ID, T0);
  const t = await runQueue(deps);
  assert.deepEqual([t.done, t.failed, t.mismatches], [1, 0, 0]);
  const inv = client.invoices[0];
  assert.equal(inv.docNumber, "1001");
  assert.equal(inv.dueDate, "2026-11-10");
  assert.equal(inv.classId, client.classes.get("DemandIQ"));           // default class name = the source's name
  assert.deepEqual(inv.lines.map((l) => [l.description, l.amountCents, l.itemId]), [
    ["Better roof package", 1_000_000, client.items.get("Roofing")], ["Good gutter package", 500_000, client.items.get("Gutters")],
  ]);
  assert.ok(client.calls.includes("createClass:DemandIQ") && client.calls.includes("createItem:Roofing"));
  assert.equal((await store.getLink("invoice", INV_ID))?.qboId, inv.id);
});

test("invoice: admin mappings win (class for a source, item for a division) and existing ones are reused, not duplicated", async () => {
  const { store, client, deps } = await setup();
  client.classes.set("Paid ads", "c-9"); client.items.set("Roofing - Shingle", "i-9");
  await store.setClassMap({ demandiq: "Paid ads" }); await store.setItemMap({ roofing: "Roofing - Shingle" });
  addInvoice(store, {}, [{ division: "roofing", description: "Good", amountCents: 1_500_000 }]);
  await enqueueInvoice(store, INV_ID, T0); await runQueue(deps);
  assert.equal(client.invoices[0].classId, "c-9");
  assert.equal(client.invoices[0].lines[0].itemId, "i-9");
  assert.ok(!client.calls.some((c) => c.startsWith("createClass") || c.startsWith("createItem")));
});

// ---------- payment link ----------
test("payment: applied to the invoice, with method and reference, and waits until the invoice is in QuickBooks", async () => {
  const { store, client, deps, advance } = await setup();
  addInvoice(store);
  store.payments.push(mkPayment(PAY1, { isDeposit: true }));
  // the payment is queued first: it must wait for its invoice
  await store.enqueue({ kind: "payment", entityId: PAY1, crmTotalCents: 500_000 }, T0);
  let t = await runQueue(deps);
  assert.deepEqual([t.waiting, t.done], [1, 0]);
  assert.equal((await store.findJob("payment", PAY1))?.attempts, 0);       // waiting is not a failed attempt
  await enqueueInvoice(store, INV_ID, T0);
  advance(3 * 60_000);
  t = await runQueue(deps);                                                // invoice first (older), payment still waits this pass or follows
  advance(3 * 60_000);
  await runQueue(deps);
  const pay = client.payments[0];
  assert.equal(pay.invoiceId, client.invoices[0].id);
  assert.equal(pay.amountCents, 500_000);
  assert.equal(pay.reference, "1042");
  assert.equal(pay.paymentMethodId, client.methods.get("Check"));
  assert.equal((await store.getLink("payment", PAY1))?.parentQboId, client.invoices[0].id);
  assert.equal((await store.findJob("payment", PAY1))?.status, "done");
});

// ---------- idempotency ----------
test("idempotency: queueing twice makes one job; running twice makes one QuickBooks invoice", async () => {
  const { store, client, deps } = await setup();
  addInvoice(store);
  const a = await enqueueInvoice(store, INV_ID, T0), b = await enqueueInvoice(store, INV_ID, T0);
  assert.equal(a?.id, b?.id);
  await runQueue(deps);
  await store.updateJob(a!.id, { status: "pending", nextAttemptAt: T0 }, T0);   // forced rerun
  await runQueue(deps);
  assert.equal(client.invoices.length, 1);
  assert.equal(client.calls.filter((c) => c === "createInvoice").length, 1);
});

test("idempotency: a lost reply is safe. The retry reuses the same RequestId, and an invoice QuickBooks already has is adopted", async () => {
  const { store, client, deps, advance } = await setup();
  addInvoice(store);
  const job = await enqueueInvoice(store, INV_ID, T0);
  client.failNext.push(new QboError("network", "Could not reach QuickBooks"));
  await runQueue(deps);
  advance(61_000);
  await runQueue(deps);
  assert.equal(client.invoices.length, 1);
  assert.equal(client.invoices[0].requestId, job!.requestId);

  // The reply was lost after QuickBooks created it: no link saved. The next run finds it by number instead of creating another.
  const s2 = await setup();
  addInvoice(s2.store);
  s2.client.customers.push(qc({ id: "55", email: "dana@example.com" }));
  s2.client.invoices.push({ id: "900", customerId: "55", docNumber: "1001", voided: false, totalCents: 1_500_000, requestId: "old", lines: [], classId: "", dueDate: "" });
  await enqueueInvoice(s2.store, INV_ID, T0); await runQueue(s2.deps);
  assert.equal(s2.client.invoices.length, 1);
  assert.equal((await s2.store.getLink("invoice", INV_ID))?.qboId, "900");
});

test("idempotency: the same payment is never applied twice", async () => {
  const { store, client, deps, advance } = await setup();
  addInvoice(store); store.payments.push(mkPayment(PAY1));
  await enqueueInvoice(store, INV_ID, T0); await store.enqueue({ kind: "payment", entityId: PAY1 }, T0);
  await runQueue(deps); advance(3 * 60_000); await runQueue(deps);
  const job = await store.findJob("payment", PAY1);
  await store.updateJob(job!.id, { status: "pending", nextAttemptAt: T0 }, T0);
  await runQueue(deps);
  assert.equal(client.payments.length, 1);
});

// ---------- retry, backoff, failed listing ----------
test("retry: network trouble backs off and tries again; after the last attempt it is listed as failed, and Retry brings it back", async () => {
  const { store, client, deps, advance } = await setup();
  addInvoice(store);
  const job = await enqueueInvoice(store, INV_ID, T0);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    client.failNext.push(new QboError("server", "QuickBooks had a problem (HTTP 503)"));
    const t = await runQueue(deps);
    assert.equal(t.retrying + t.failed, 1);
    const j = await store.getJob(job!.id);
    if (i < MAX_ATTEMPTS - 1) {
      assert.equal(j?.status, "pending");
      assert.equal(j!.nextAttemptAt.getTime() - deps.now().getTime(), backoffMs(i + 1));
      assert.equal((await runQueue(deps)).done, 0);                         // not due yet: nothing is claimed
      advance(backoffMs(i + 1) + 1);
    }
  }
  const failed = await store.listJobs({ statuses: ["failed"], limit: 10 });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].attempts, MAX_ATTEMPTS);
  assert.match(failed[0].lastError ?? "", /503/);
  assert.equal((await store.counts()).failed, 1);

  assert.equal(await retryJob(store, job!.id, deps.now()), true);
  assert.equal(await retryJob(store, job!.id, deps.now()), false);          // only failed jobs can be retried
  const t = await runQueue(deps);
  assert.equal(t.done, 1);
  assert.equal(client.invoices.length, 1);
  assert.equal((await store.counts()).failed, 0);
});

test("retry: a refusal from QuickBooks (bad data or mapping) fails at once with its reason; backoff grows", async () => {
  const { store, client, deps } = await setup();
  addInvoice(store);
  const job = await enqueueInvoice(store, INV_ID, T0);
  client.failNext.push(new QboError("validation", "Invalid Reference Id: Item"));
  const t = await runQueue(deps);
  assert.deepEqual([t.failed, t.retrying], [1, 0]);
  assert.match((await store.getJob(job!.id))!.lastError!, /Invalid Reference/);
  assert.ok(backoffMs(1) < backoffMs(2) && backoffMs(2) < backoffMs(6));
  assert.equal(backoffMs(99), backoffMs(6));
});

test("auth: a refused token pauses the queue without using an attempt, and nothing else is sent", async () => {
  const { store, client, deps } = await setup();
  addInvoice(store); store.payments.push(mkPayment(PAY1));
  const job = await enqueueInvoice(store, INV_ID, T0); await store.enqueue({ kind: "payment", entityId: PAY1 }, T0);
  client.failNext.push(new QboError("auth", "QuickBooks needs to be connected again"));
  const t = await runQueue(deps);
  assert.equal(t.stoppedForAuth, true);
  assert.equal((await store.getJob(job!.id))?.attempts, 0);
  assert.equal((await store.findJob("payment", PAY1))?.status, "pending");
  assert.equal(client.invoices.length, 0);
});

// ---------- totals ----------
test("round trip: QuickBooks total must equal the CRM total; a difference is flagged (and can be marked reviewed)", async () => {
  const ok = await setup();
  addInvoice(ok.store); const j1 = await enqueueInvoice(ok.store, INV_ID, T0);
  await runQueue(ok.deps);
  const done = await ok.store.getJob(j1!.id);
  assert.deepEqual([done?.mismatch, done?.crmTotalCents, done?.qboTotalCents], [false, 1_500_000, 1_500_000]);

  const bad = await setup();
  bad.client.taxCents = 12_345;                                             // QuickBooks added sales tax
  addInvoice(bad.store); const j2 = await enqueueInvoice(bad.store, INV_ID, T0);
  const t = await runQueue(bad.deps);
  assert.deepEqual([t.done, t.mismatches], [1, 1]);
  const flagged = await bad.store.getJob(j2!.id);
  assert.equal(flagged?.mismatch, true);
  assert.match(flagged?.lastError ?? "", /\$1,512,345\.00|\$15,123\.45/);
  assert.equal((await bad.store.listJobs({ statuses: ["done"], mismatchOnly: true, limit: 10 })).length, 1);
  assert.equal(await acknowledgeMismatch(bad.store, j2!.id), true);
  assert.equal((await bad.store.counts()).mismatch, 0);
});

test("round trip: lines that don't add up to the contract are caught as a mismatch, never silently adjusted", async () => {
  const { store, client, deps } = await setup();
  addInvoice(store, {}, [{ division: "roofing", description: "Better", amountCents: 1_400_000 }]);   // contract says 1,500,000
  const job = await enqueueInvoice(store, INV_ID, T0);
  await runQueue(deps);
  assert.equal((await store.getJob(job!.id))?.mismatch, true);
  assert.equal(client.invoices[0].totalCents, 1_400_000);
});

// ---------- voids ----------
test("void payment: voided in QuickBooks and unlinked; voided before it was ever sent is just cancelled", async () => {
  const { store, client, deps, advance } = await setup();
  addInvoice(store); store.payments.push(mkPayment(PAY1), mkPayment(PAY2));
  await enqueueInvoice(store, INV_ID, T0);
  await store.enqueue({ kind: "payment", entityId: PAY1 }, T0);
  await runQueue(deps); advance(3 * 60_000); await runQueue(deps);
  assert.equal(client.payments.length, 1);

  store.payments[0].voidedAt = deps.now();
  await store.enqueue({ kind: "payment", entityId: PAY2 }, T0);               // PAY2 never sent...
  store.payments[1].voidedAt = deps.now();                                    // ...and voided
  assert.equal((await sweep(store, deps.now())).queued, 2);                   // both void jobs queued by the sweep
  await runQueue(deps);
  assert.equal(client.payments[0].voided, true);
  assert.equal(await store.getLink("payment", PAY1), null);
  assert.equal((await store.findJob("payment", PAY2))?.status, "cancelled");
  assert.equal(client.payments.length, 1);
});

test("void invoice: payments applied to it are voided first and re-queued for the replacement invoice", async () => {
  const { store, client, deps, advance } = await setup();
  addInvoice(store); store.payments.push(mkPayment(PAY1));
  await enqueueInvoice(store, INV_ID, T0); await store.enqueue({ kind: "payment", entityId: PAY1 }, T0);
  await runQueue(deps); advance(3 * 60_000); await runQueue(deps);
  const firstInvoiceQbo = client.invoices[0].id;

  store.invoices[0].status = "void";
  await sweep(store, deps.now());
  advance(1000);
  await runQueue(deps);
  assert.equal(client.invoices[0].voided, true);
  assert.equal(client.payments[0].voided, true);
  assert.equal(await store.getLink("invoice", INV_ID), null);
  const pj = await store.findJob("payment", PAY1);
  assert.equal(pj?.status, "waiting");

  // a replacement invoice is issued; the payment follows it
  const NEW_INV = "00000000-0000-4000-8000-0000000000a2";
  addInvoice(store, { id: NEW_INV, invoiceNumber: 1002 });
  await sweep(store, deps.now());
  advance(3 * 60_000); await runQueue(deps);
  advance(3 * 60_000); await runQueue(deps);
  const live = client.payments.filter((p) => !p.voided);
  assert.equal(live.length, 1);
  assert.notEqual(live[0].invoiceId, firstInvoiceQbo);
  assert.equal(live[0].invoiceId, client.invoices.find((i) => i.docNumber === "1002")?.id);
});

test("void invoice that never reached QuickBooks: its pending push is cancelled and nothing is created", async () => {
  const { store, client, deps } = await setup();
  addInvoice(store);
  const job = await enqueueInvoice(store, INV_ID, T0);
  store.invoices[0].status = "void";
  await sweep(store, T0);
  await runQueue(deps);
  assert.equal(client.invoices.length, 0);
  assert.equal((await store.getJob(job!.id))?.status, "cancelled");
});

// ---------- sweep ----------
test("sweep: queues new invoices and payments after the connection date only, once", async () => {
  const { store, deps } = await setup({ syncFrom: new Date(T0.getTime() - 1000) });
  addInvoice(store, { id: "00000000-0000-4000-8000-0000000000a9", invoiceNumber: 900, issuedAt: new Date(T0.getTime() - 86_400_000) });   // before connecting
  addInvoice(store);
  store.payments.push(mkPayment(PAY1), mkPayment(PAY2, { receivedAt: new Date(T0.getTime() - 86_400_000) }));
  assert.equal((await sweep(store, deps.now())).queued, 2);
  assert.equal((await sweep(store, deps.now())).queued, 0);
  assert.ok(await store.findJob("invoice", INV_ID) && await store.findJob("payment", PAY1));
  assert.equal(await store.findJob("payment", PAY2), null);
});

test("sweep: does nothing until QuickBooks has been connected", async () => {
  const store = new MemoryQboStore();
  store.invoices.push(mkInvoice());
  assert.equal((await sweep(store, T0)).queued, 0);
});

test("switching to a different QuickBooks company clears links and the queue so sandbox ids never leak into production", async () => {
  const { store } = await setup();
  addInvoice(store); await enqueueInvoice(store, INV_ID, T0);
  await store.setLink("customer", CUST.id, "55"); await store.setRef("class", "DemandIQ", "9");
  const same = await store.saveConnection({ realmId: "9130", companyName: "A&A", environment: "sandbox" }, T0);
  assert.equal(same.companyChanged, false);
  assert.ok(await store.getLink("customer", CUST.id));
  const other = await store.saveConnection({ realmId: "4620", companyName: "A&A", environment: "production" }, T0);
  assert.equal(other.companyChanged, true);
  assert.equal(await store.getLink("customer", CUST.id), null);
  assert.equal(await store.getRef("class", "DemandIQ"), null);
  assert.equal((await store.counts()).pending, 0);
});
