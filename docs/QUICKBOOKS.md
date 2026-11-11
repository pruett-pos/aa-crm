# QuickBooks Online push

The CRM sends customers, invoices, payments and voids **one way, to A&A Quality Roofing's own QuickBooks Online company**
(not Pruett's, which is a separate company and a separate Intuit connection). Nothing is ever read back into the CRM except
the company name and the id and total QuickBooks gives each record.

Code: `src/integrations/quickbooks/` (Intuit API and OAuth), `src/lib/quickbooks/` (queue, sync rules, stores),
screens at **Settings, QuickBooks** (admin) and **Settings, QuickBooks, sync status** (admin and accounting),
cron script `scripts/quickbooks-sync.ts`. Database: `db/migrations/015_quickbooks.sql`.

## Setup for AL

### 1. Paste the keys into Railway (development keys first)

Railway, the CRM service, **Variables**:

| Variable | Value |
|---|---|
| `QBO_CLIENT_ID` | The Client ID from Intuit (developer.intuit.com, your app, **Keys and credentials**, Development) |
| `QBO_CLIENT_SECRET` | The Client Secret from the same page |
| `QBO_ENVIRONMENT` | `sandbox` |
| `QBO_REDIRECT_URI` | `https://crm.aaqualityroofing.com/api/quickbooks/callback` (exactly; it must match what is registered at Intuit, character for character) |
| `INTEGRATION_KEY` | Already set for Hover. The QuickBooks tokens are encrypted with the same key. |

For local work use `http://localhost:3000/api/quickbooks/callback` in `.env`. Keys are never logged or committed.

Run the migration on the database once (dev now; production through the migration runner):
`psql $DATABASE_URL -f db/migrations/015_quickbooks.sql`

### 2. Connect

1. Sign in to the CRM as an admin, open **Settings, QuickBooks**, press **Connect QuickBooks**.
2. Intuit asks you to sign in and pick a company. With development keys it offers your **sandbox** company; use that.
3. You land back on the page with "Connected to <company> (sandbox)". The page shows the company name.
4. Only invoices issued and payments recorded **after you connect** are sent. Old history is never pushed.

### 3. Check the QuickBooks company is ready

These are settings inside QuickBooks that the CRM cannot change:

- **Turn on custom transaction numbers** (Settings, Account and settings, Sales, "Custom transaction numbers"). The CRM sends its invoice number (1001...) as the QuickBooks invoice number. Without this, QuickBooks numbers the invoice itself and the numbers won't match.
- **Turn on class tracking** (Settings, Account and settings, Advanced, Categories, "Track classes"). Each invoice is tagged with its lead source as a class.
- **Sales tax**: the CRM prices have no tax. If QuickBooks adds tax or a discount to the invoice, the total won't match; the sync screen flags it as a **total mismatch**. Turn off automatic sales tax for these invoices, or tell me how tax should work.
- QuickBooks needs at least one **Income** account (every company has one). New service items are attached to an account named "Services" if it exists, otherwise the first income account.

### 4. Map lead sources and divisions (optional)

On **Settings, QuickBooks**:

- **Classes**: type the QuickBooks class name to use for each lead source. Blank = the source's own name (Phone, DemandIQ, Website...). A missing class is created.
- **Products and services**: type the QuickBooks item to use for each division. Blank = the division's name (Roofing, Siding, Gutters, Windows and doors...). A missing item is created as a Service.

### 5. Run the cron

Add a Railway **cron service** (same repo, same variables) every 5 minutes:

```bash
npm run quickbooks:sync
```

It queues anything new, sends what is due, retries what failed earlier, and keeps the sign-in alive (QuickBooks' refresh token lasts about 100 days and is renewed each time the cron runs, so nobody has to reconnect). `npm run quickbooks:sync -- --dry-run` only prints counts.

Pushing also starts in the background the moment an invoice is issued, a payment is recorded, or either is voided. The cron is the safety net.

### 6. Switch to production

1. In Intuit, finish the production-keys questionnaire (answers below) and get the **Production** Client ID and Secret.
2. In Railway set `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` to the production values, `QBO_ENVIRONMENT=production`. `QBO_REDIRECT_URI` stays `https://crm.aaqualityroofing.com/api/quickbooks/callback` (it must also be registered under the production keys).
3. Redeploy. **Settings, QuickBooks** now says "needs to be connected again" or "not connected". Press **Connect QuickBooks**, sign in to **A&A's real company**.
4. Connecting to a different company (or sandbox to production) **clears the saved QuickBooks ids and the queue**, so nothing from the test company can leak into the real books. `sync from` starts again at that moment.

## What gets sent

| CRM event | QuickBooks |
|---|---|
| Invoice issued | The customer (matched by email, then phone, then name, otherwise created; the QuickBooks id is stored), then an **Invoice**: invoice number, issue date, due date, one line per trade (item for that division, the chosen package as the description), bill-to address = the property, **class = lead source**. |
| Payment recorded | A **Payment** applied to the job's live invoice, with payment method (Check, Credit Card, ACH, Cash, Insurance check, Financing; created if missing) and the reference. A payment recorded before the invoice exists waits for it. |
| Payment voided | The QuickBooks payment is voided. If it was never sent, its pending push is cancelled. |
| Invoice voided | Payments applied to it are voided in QuickBooks first (QuickBooks refuses otherwise), then the invoice is voided. Those payments are still good in the CRM, so they are sent again to the replacement invoice. |

Matching the customer is best effort: QuickBooks only searches exact email, phone and display name, so a customer typed into QuickBooks as "Dana M." with no email or phone is not recognised and a new one is created. If a *different* person already has the same display name, the new customer is named "First Last (abcd1234)".

### Safety rules

- **Never double-created.** Every push is a row in `qbo_sync_jobs` with a fixed `request_id` that is sent to QuickBooks as `RequestId`. A retry after a lost reply returns the original. Invoices are also looked up by number first and an existing one is adopted.
- **Retries.** Network, rate limit and QuickBooks outage errors retry with backoff (1 min, 5 min, 15 min, 1 h, 4 h, 12 h) up to 8 tries, then show as **Failed**. QuickBooks refusing the data (a bad mapping, a closed period) fails at once with QuickBooks' reason. **Retry** on the sync screen puts it back in the queue with the same RequestId. If QuickBooks refuses the saved access, sending stops (no tries are used) until an admin reconnects.
- **Totals.** After each invoice and payment the total QuickBooks recorded is compared with the CRM's, to the cent. A difference is listed under **Total mismatches** until someone marks it reviewed.
- **Money** is integer cents in the CRM; dollars appear only at the QuickBooks boundary (`src/integrations/quickbooks/client.ts`).

## Not covered yet

Pulling anything from QuickBooks, change orders and partial invoices (the CRM doesn't have them yet), commission payouts, refunds, sales tax, Helcim fee entries, editing an invoice after it is sent (a mistake is voided and reissued).

## Testing status

Tested against a **fake QuickBooks** built from Intuit's published API (tests/quickbooks.test.ts), not against the real sandbox. Before relying on it, connect the sandbox, issue one test invoice and record one test payment, and check the sync screen shows them as sent and the totals match. Intuit's query syntax for phone matching (`PrimaryPhone = '417-555-0123'`) is the least certain part; if it errors, name matching still works.

---

## Intuit production-keys questionnaire: answers to paste

Intuit asks for these when you request production keys. Edit the bracketed items.

**App name / what does it do?** A&A CRM, an in-house system used only by A&A Exterior Group / A&A Quality Roofing staff to manage roofing, siding and gutter jobs. It creates the customer, invoice and payment records in A&A's own QuickBooks Online company when staff issue an invoice or record a payment.

**Who uses it?** Only A&A employees (an admin, accounting staff, estimators). It is not a public or multi-company app and is connected to one QuickBooks company, A&A's own.

**Scope requested and why:** `com.intuit.quickbooks.accounting` only. Needed to: search and create Customers, Classes, Items (service), Payment Methods; create Invoices and Payments; void Invoices and Payments; read Company Info (to show the company name on the connect screen). Nothing else is requested (no payments API, no payroll).

**What data do you read?** Company name; existing customers (to avoid duplicates), classes, items, payment methods, accounts (to pick an income account for a new service item), and invoice lookup by number. Nothing is copied into the CRM except the QuickBooks id and total of records the CRM created or matched.

**What data do you write?** Customer name, email, phone; invoice number, dates, line items (trade, package name, amount), bill-to address (the job's property), lead-source class; payment amount, date, method, reference number; voids.

**How is data stored?** Access and refresh tokens are encrypted with AES-256-GCM (key `INTEGRATION_KEY`, kept only in the server environment, never in the code repository) in A&A's PostgreSQL database on Railway. Tokens are never shown on screens, written to logs, or put in URLs. The realm id and company name are stored in plain text. QuickBooks customer and invoice data is not copied into the CRM beyond ids and totals.

**Security.** Server-side OAuth 2.0 authorization code flow with a random `state` checked against an HTTP-only cookie; only signed-in admins can connect or disconnect; HTTPS only; client secret only in server environment variables; refresh tokens are saved before use (they rotate) and a refused token stops syncing instead of retrying; Disconnect revokes the grant at Intuit and deletes the stored tokens; role checks on every API route; access to the sync screen limited to admin and accounting.

**Privacy.** Customer information is used only to create the customer's invoices and payments in A&A's own books. It is not sold, shared, or used for advertising. Data stays in A&A's QuickBooks and the CRM database. Customers' QuickBooks data is not sent to anyone else. [AL: confirm how long you keep records; A&A's records policy applies.]

**Data deletion / disconnect.** An admin presses Disconnect on Settings, QuickBooks, which revokes the grant at Intuit and deletes the stored tokens. Closing the connection from QuickBooks (My Apps) also stops access; the CRM then shows "needs to be connected again".

**URLs Intuit will ask for. These need to exist on a public page before you submit:**

| Field | Value |
|---|---|
| Host domain | `crm.aaqualityroofing.com` |
| Launch URL | `https://crm.aaqualityroofing.com/login` (sign-in only; staff accounts) |
| Redirect URI | `https://crm.aaqualityroofing.com/api/quickbooks/callback` |
| Disconnect URL | `https://crm.aaqualityroofing.com/settings/quickbooks` |
| **Privacy policy URL** | **[AL: needed. Publish a page, for example `https://aaqualityroofing.com/privacy`, saying what data the CRM handles, that it's used only for A&A's books, not sold, how to ask for deletion.]** |
| **Terms of service / EULA URL** | **[AL: needed. For an in-house tool a short page, for example `https://aaqualityroofing.com/terms`, stating the app is for A&A staff use only.]** |
| Support / contact email | [AL: an address that someone reads] |

Intuit may also ask for the app's **category** (Accounting / CRM), **regions** (United States), whether you are a **service provider or end user** (end user: this is A&A's own app), and a **security assessment** (a short form: HTTPS, encrypted tokens, role-based access; answers above).
