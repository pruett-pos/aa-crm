// The QuickBooks Online accounting API (v3), as the CRM uses it. Everything the sync engine needs is on the QboClient
// interface so tests can run against a fake. Money crosses this boundary as integer cents; QuickBooks speaks dollars,
// so the conversion is done here and nowhere else. Never called from UI code: only src/lib/quickbooks/ uses it.
import { QboError } from "./errors.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type QboCustomer = {
  id: string; displayName: string; givenName: string | null; familyName: string | null; email: string | null; phone: string | null;
  /** Billing address (falls back to the shipping address): street line and postal code, as QuickBooks has them. */
  address: { line1: string; postalCode: string } | null;
};
export type QboAddress = { line1: string; city: string; state: string; postalCode: string };
export type NewQboCustomer = { requestId: string; displayName: string; givenName: string; familyName: string; email: string | null; phone: string | null; address: QboAddress | null };
export type QboInvoiceLine = { itemId: string; description: string; amountCents: number };
export type NewQboInvoice = {
  requestId: string; customerId: string; classId: string; docNumber: string; txnDate: string; dueDate: string;
  lines: QboInvoiceLine[]; address: QboAddress; memo: string;
};
export type QboInvoiceInfo = { id: string; customerId: string; totalCents: number; docNumber: string | null; voided: boolean };
export type NewQboPayment = {
  requestId: string; customerId: string; invoiceId: string; amountCents: number; txnDate: string;
  paymentMethodId: string | null; reference: string | null; memo: string;
};

export interface QboClient {
  companyName(): Promise<string>;
  /** Candidates by email and by display name. The CRM decides which of them is the same person. */
  findCustomers(q: { email?: string | null; displayName?: string | null }): Promise<QboCustomer[]>;
  createCustomer(c: NewQboCustomer): Promise<{ id: string }>;
  findClassByName(name: string): Promise<string | null>;
  createClass(name: string, requestId: string): Promise<string>;
  findItemByName(name: string): Promise<string | null>;
  findIncomeAccountId(): Promise<string | null>;
  createServiceItem(name: string, incomeAccountId: string, requestId: string): Promise<string>;
  findPaymentMethodByName(name: string): Promise<string | null>;
  createPaymentMethod(name: string, requestId: string): Promise<string>;
  findInvoiceByDocNumber(docNumber: string): Promise<QboInvoiceInfo | null>;
  createInvoice(i: NewQboInvoice): Promise<QboInvoiceInfo>;
  createPayment(p: NewQboPayment): Promise<{ id: string; totalCents: number }>;
  voidInvoice(id: string): Promise<void>;
  voidPayment(id: string): Promise<void>;
}

export const centsToDollars = (cents: number): number => Number((cents / 100).toFixed(2));
export const dollarsToCents = (d: unknown): number => Math.round(Number(d) * 100);

/** QuickBooks query strings: a single quote or backslash inside a value must be escaped. */
export const qboQuote = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const MINOR_VERSION = "75";

export type QboClientOptions = {
  apiBase: string;                                  // https://quickbooks.api.intuit.com or the sandbox host
  realmId: string;
  getAccessToken: (forceRefresh: boolean) => Promise<string>;
  fetch?: FetchLike;
  timeoutMs?: number;
};

type J = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

export function createQboClient(o: QboClientOptions): QboClient {
  const doFetch: FetchLike = o.fetch ?? ((u, i) => fetch(u, i));

  async function call(method: "GET" | "POST", path: string, params: Record<string, string> = {}, body?: unknown): Promise<J> {
    const q = new URLSearchParams({ ...params, minorversion: MINOR_VERSION });
    const url = `${o.apiBase}/v3/company/${encodeURIComponent(o.realmId)}/${path}?${q.toString()}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await o.getAccessToken(attempt === 1);
      let res: Response;
      try {
        res = await doFetch(url, {
          method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
        });
      } catch {
        throw new QboError("network", "Could not reach QuickBooks");
      }
      if (res.status === 401 && attempt === 0) continue;       // the token may just have expired: refresh once and retry
      if (res.ok) {
        try { return (await res.json()) as J; } catch { throw new QboError("server", "Unexpected response from QuickBooks"); }
      }
      throw await faultFrom(res);
    }
    throw new QboError("auth", "QuickBooks refused the access token");
  }

  async function faultFrom(res: Response): Promise<QboError> {
    if (res.status === 401 || res.status === 403) return new QboError("auth", `QuickBooks refused access (HTTP ${res.status})`);
    if (res.status === 429) return new QboError("rate_limit", "QuickBooks is rate limiting requests (HTTP 429)");
    if (res.status >= 500) return new QboError("server", `QuickBooks had a problem (HTTP ${res.status})`);
    let msg = `QuickBooks refused the request (HTTP ${res.status})`, code = "";
    try {
      const e = (await res.json())?.Fault?.Error?.[0];
      if (e) { code = String(e.code ?? ""); msg = [e.Message, e.Detail].filter(Boolean).join(": ").slice(0, 300) || msg; }
    } catch { /* keep the generic text */ }
    // 6240 = duplicate name. Intuit's own text only: never the request body, so no customer data is logged.
    if (code === "6240") return new QboError("duplicate", msg);
    return new QboError(res.status === 404 ? "not_found" : "validation", msg);
  }

  const query = async (select: string): Promise<J[]> => {
    const j = await call("GET", "query", { query: select });
    const r = j.QueryResponse ?? {};
    const key = Object.keys(r).find((k) => Array.isArray(r[k]));
    return key ? r[key] : [];
  };
  const first = async (entity: string, field: string, value: string) => (await query(`select * from ${entity} where ${field} = ${qboQuote(value)}`))[0] ?? null;
  const post = (entity: string, requestId: string | null, body: unknown, extra: Record<string, string> = {}) =>
    call("POST", entity, { ...(requestId ? { requestid: requestId } : {}), ...extra }, body);

  const toCustomer = (c: J): QboCustomer => ({
    id: String(c.Id), displayName: String(c.DisplayName ?? ""), givenName: c.GivenName ?? null, familyName: c.FamilyName ?? null,
    email: c.PrimaryEmailAddr?.Address ?? null, phone: c.PrimaryPhone?.FreeFormNumber ?? null,
    address: (() => { const a = c.BillAddr ?? c.ShipAddr; return a?.Line1 ? { line1: String(a.Line1), postalCode: String(a.PostalCode ?? "") } : null; })(),
  });
  const toInvoice = (i: J): QboInvoiceInfo => ({
    id: String(i.Id), customerId: String(i.CustomerRef?.value ?? ""), totalCents: dollarsToCents(i.TotalAmt ?? 0), docNumber: i.DocNumber ?? null,
    voided: /^voided/i.test(String(i.PrivateNote ?? "")) || (Number(i.TotalAmt) === 0 && Number(i.Balance) === 0 && /void/i.test(String(i.PrivateNote ?? ""))),
  });

  return {
    async companyName() {
      const j = await call("GET", `companyinfo/${encodeURIComponent(o.realmId)}`);
      return String(j.CompanyInfo?.CompanyName ?? j.CompanyInfo?.LegalName ?? "QuickBooks company");
    },

    async findCustomers(q) {
      const found = new Map<string, QboCustomer>();
      const add = (rows: J[]) => rows.forEach((r) => found.set(String(r.Id), toCustomer(r)));
      if (q.email) add(await query(`select * from Customer where PrimaryEmailAddr = ${qboQuote(q.email)}`));
      if (q.displayName) add(await query(`select * from Customer where DisplayName = ${qboQuote(q.displayName)}`));
      return [...found.values()];
    },

    async createCustomer(c) {
      const body: J = { DisplayName: c.displayName, GivenName: c.givenName.slice(0, 25), FamilyName: c.familyName.slice(0, 25) };
      if (c.email) body.PrimaryEmailAddr = { Address: c.email };
      if (c.phone) body.PrimaryPhone = { FreeFormNumber: c.phone };
      if (c.address) body.BillAddr = { Line1: c.address.line1, City: c.address.city, CountrySubDivisionCode: c.address.state, PostalCode: c.address.postalCode };
      const j = await post("customer", c.requestId, body);
      return { id: String(j.Customer.Id) };
    },

    async findClassByName(name) {
      const r = await first("Class", "Name", name);
      return r ? String(r.Id) : null;
    },
    async createClass(name, requestId) {
      return String((await post("class", requestId, { Name: name })).Class.Id);
    },

    async findItemByName(name) {
      const r = await first("Item", "Name", name);
      return r ? String(r.Id) : null;
    },
    async findIncomeAccountId() {
      const rows = await query("select * from Account where AccountType = 'Income' and Active = true maxresults 50");
      const pick = rows.find((r) => /^services$/i.test(String(r.Name))) ?? rows.find((r) => r.AccountSubType === "ServiceFeeIncome" || r.AccountSubType === "SalesOfProductIncome") ?? rows[0];
      return pick ? String(pick.Id) : null;
    },
    async createServiceItem(name, incomeAccountId, requestId) {
      const j = await post("item", requestId, { Name: name, Type: "Service", IncomeAccountRef: { value: incomeAccountId } });
      return String(j.Item.Id);
    },

    async findPaymentMethodByName(name) {
      const r = await first("PaymentMethod", "Name", name);
      return r ? String(r.Id) : null;
    },
    async createPaymentMethod(name, requestId) {
      return String((await post("paymentmethod", requestId, { Name: name })).PaymentMethod.Id);
    },

    async findInvoiceByDocNumber(docNumber) {
      const r = await first("Invoice", "DocNumber", docNumber);
      return r ? toInvoice(r) : null;
    },
    async createInvoice(i) {
      const body: J = {
        CustomerRef: { value: i.customerId }, DocNumber: i.docNumber, TxnDate: i.txnDate, DueDate: i.dueDate,
        ClassRef: { value: i.classId }, PrivateNote: i.memo.slice(0, 4000),
        BillAddr: { Line1: i.address.line1, City: i.address.city, CountrySubDivisionCode: i.address.state, PostalCode: i.address.postalCode },
        Line: i.lines.map((l) => ({
          DetailType: "SalesItemLineDetail", Amount: centsToDollars(l.amountCents), Description: l.description.slice(0, 4000),
          SalesItemLineDetail: { ItemRef: { value: l.itemId }, ClassRef: { value: i.classId }, Qty: 1, UnitPrice: centsToDollars(l.amountCents) },
        })),
      };
      return toInvoice((await post("invoice", i.requestId, body)).Invoice);
    },

    async createPayment(p) {
      const body: J = {
        CustomerRef: { value: p.customerId }, TotalAmt: centsToDollars(p.amountCents), TxnDate: p.txnDate, PrivateNote: p.memo.slice(0, 4000),
        Line: [{ Amount: centsToDollars(p.amountCents), LinkedTxn: [{ TxnId: p.invoiceId, TxnType: "Invoice" }] }],
      };
      if (p.paymentMethodId) body.PaymentMethodRef = { value: p.paymentMethodId };
      if (p.reference) body.PaymentRefNum = p.reference.slice(0, 21);
      const pay = (await post("payment", p.requestId, body)).Payment;
      return { id: String(pay.Id), totalCents: dollarsToCents(pay.TotalAmt) };
    },

    async voidInvoice(id) {
      const cur = (await call("GET", `invoice/${encodeURIComponent(id)}`)).Invoice;
      if (toInvoice(cur).voided) return;                      // already voided (a retry after a lost reply)
      await post("invoice", null, { Id: cur.Id, SyncToken: cur.SyncToken }, { operation: "void" });
    },
    async voidPayment(id) {
      const cur = (await call("GET", `payment/${encodeURIComponent(id)}`)).Payment;
      if (Number(cur.TotalAmt) === 0 && /void/i.test(String(cur.PrivateNote ?? ""))) return;
      await post("payment", null, { Id: cur.Id, SyncToken: cur.SyncToken, TotalAmt: cur.TotalAmt, sparse: true }, { operation: "update", include: "void" });
    },
  };
}
