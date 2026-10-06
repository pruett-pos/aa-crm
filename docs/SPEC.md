# A&A CRM — Product spec (v0.1, draft)

Owner: AL Kharitonov. Goal for day 90: a working prototype that runs real
jobs in parallel with Leap for one estimator. Full cutover is a separate decision.

## 1. Users and roles

| Role | Can do |
|---|---|
| Admin (AL, office manager) | Everything, incl. commission settings and user management |
| CSR | Create leads/customers, book appointments, view all jobs, route calls |
| Estimator | Own leads and jobs; build scopes; sign contracts; record payments; see **only their own** commissions |
| Production Manager | Their division's jobs from contract onward; schedule crews; closeout; see scope margin |
| Crew leader | Read-only view of assigned jobs, upload photos, request change orders |
| Accounting | Invoices, payments, depreciation, commission payouts, QBO sync status |

## 2. Lead intake

Sources: phone (~90%), DemandIQ, website form, Google scheduling, Facebook,
referral, canvassing. Every lead records its source; ad spend per source per
month is entered in Settings so cost-per-lead and cost-per-win are always populated
(this was never filled in Leap).

- **Phone:** CSR searches by phone/address first. Routing rule:
  existing customer → the estimator who handled them last; no estimator on
  file → the Production Manager of the requested division.
- **DemandIQ:** webhook creates customer + property + lead with the instant
  quote attached; flagged `online_quote`. (Integration details: confirm with DemandIQ.)
- **Website form:** POST endpoint replaces the WordPress form's email.
- CSR captures: retail vs. insurance, division(s), appointment slot, estimator.

## 3. Inspections

- Free exterior inspection (default for homeowners).
- Paid Exterior Condition Report, $249 (mostly realtors/home buyers) — is its
  own job type with an invoice, no scope.

## 4. Pipeline

One job per property per project. Stages (insurance-only stages marked *):

1. New lead
2. Appointment set
3. Inspected
4. Contingency signed *
5. Claim approved *
6. Scope presented (Good/Better/Best)
7. Contract signed
8. Deposit collected
9. Materials ordered
10. Scheduled
11. In production
12. Closeout punchlist
13. Invoiced
14. Depreciation pending *
15. Paid in full

Exit states: Lost (reason required), Cancelled after approval * (triggers cancellation fee).

## 5. Scopes of work

- Measurements imported from Hover (manual entry allowed).
- Three packages, Good/Better/Best, built from line items. Material line
  items price from the Pruett catalog at Builder plan (retail − 12%),
  refreshed by a nightly sync from Pruett POS.
- Each scope shows estimated material cost, labor cost, sale price, and gross
  margin % — margin is visible to estimator, Production Manager and admin, never on the customer PDF.
- Customer picks a package -> contract generated -> signed in person on the estimator's tablet, inside the CRM (no outside e-signature vendor; decided 2026-10). The signed PDF is locked and carries a certificate page with the audit trail, and the customer is emailed a copy.

## 6. Insurance jobs

- Contingency agreement signed at inspection. A&A fee = 10% of what insurance has paid so far.
- If homeowner does not proceed after claim approval: cancellation fee = 5% of payout.
- Customer type: `deductible_only` (pays deductible, covered repairs) or
  `upgrade` (covered repairs + paid upgrades, priced as a separate change order).
- Track: carrier, claim #, adjuster, adjuster meeting date, approved RCV,
  ACV, depreciation held, supplements (each with amount and status), deductible.
- Depreciation is collected once the insured receives the carrier check.

## 7. Deposits and payments

- 50% deposit required if contract total > $5,000 **or** any special-order material.
- Estimators can record field payments (check/card) with a photo of the check; office staff (admin, accounting) can record any payment, with the photo optional. Cards are taken in Helcim and recorded here with the Helcim transaction number: the CRM is record-only for cards and never stores card numbers.
- All invoices and payments sync to QuickBooks Online.

## 8. Post-sale and production

- Estimator enters color/material selections → material list generated from
  the chosen package → sent to Pruett as a purchase order (later: directly into Pruett POS).
- Estimator schedules install date and hands off to crew leader.
- Crews: subcontractors or employees; pay per square, hourly on odd jobs.
- Change orders: crew leader requests in app → estimator presents to client → client e-signs.
- Closeout punchlist (English/Russian) must be complete before invoicing.
- Photos: link the CompanyCam project to the job (API), don't re-host.

## 9. Commission

- Base rate 8% of sale price at ≥ 40% gross margin; 10% if estimator uses own truck and fuel.
- Lose 1 percentage point of commission for every 2 points of gross margin below 40%. Floor 0%.
- Paid on amount collected, not on amount sold.
- Draw against commission: draws are tracked per estimator and netted against commissions earned.

## 10. Reports (feed the managers' L10)

Close rate (by estimator, division, source), sales by division and rep,
cost per lead / per won job by source, average days contract → install,
outstanding depreciation, AR aging, commissions owed.

## 11. Integrations

| System | Direction | Phase |
|---|---|---|
| DemandIQ | in (leads) | 1 |
| QuickBooks Online | out (customers, invoices, payments) | 1 |
| Pruett POS | in (nightly prices); out (POs) later | 1 |
| E-signature | built into the CRM (no vendor) | 1 |
| Hover | in (measurements) | 2 |
| CompanyCam | link | 2 |
| Leap | one-time import of contacts, jobs, documents | 2 |
| Twilio SMS/voice | appointment reminders, AI call answering | 3 |

## 12. Open questions for AL

1. Commission step: is it per **full** 2 points below 40% (39% GM → still 8%)
   or proportional (39% → 7.5%)? Current code: full steps.
2. Is the 10% contingency fee charged on RCV (full approved amount) or ACV?
3. Does the "upgrade" portion of an insurance job earn retail commission rules?
4. Should Production Managers see margin?
5. Which e-signature vendor?

## Decision log

- 2026-10: Stack = Next.js + Postgres on Railway, alongside Pruett POS.
- 2026-10: Business rules centralised in `src/lib/rules.ts`.
- 2026-10 (open questions resolved by AL):
  1. Commission uses full 2-point steps: 39% GM still pays 8%. No code change.
  2. Contingency fee = 10% of what insurance has already paid (ACV, then released
     depreciation), recalculated as payments arrive. Not RCV.
  3. Upgrade portion is a separate retail scope of work (change order) and earns
     retail commission on its own margin; no contingency fee applies to it.
     Open detail: if an upgrade replaces a covered line item, include only the
     customer-paid difference.
  4. Production Managers can see margin (updates the Scopes rule in section 5 and the roles table).
  5. E-signature: NO outside vendor. Signing is built into the CRM (see slice 3 below). Dropbox Sign and DocuSign were dropped.
- 2026-10 (slice 2, scope builder):
  - Customer price is set by a per-scope target margin (default 40%, max 95%):
    price = cost / (1 - target), rounded per line. Actual margin is always displayed.
    Rules: `priceForTargetMarginCents`, `scopeTotals`, `scopeCommissionRateBps` in `rules.ts`.
  - Materials cost the Pruett Builder price (retail - 12%). Until the nightly sync exists,
    `db/seed_products.sql` provides a fake sample catalog. Labor and other lines take a typed cost.
  - The server computes all prices; the client never sends a price.
  - Scope access: admin and the job's own estimator can edit. A Production Manager can read
    (with margin) their division's jobs from `contract_signed` onward. Commission preview shows
    only to admin and the job's own estimator.
  - Decided by AL: a Production Manager is matched to jobs by division only, with no market
    limit. `division_managers` rows for the job's divisions in any market grant access.
- 2026-10 (slice 3, contracts and signing):
  - AL reversed the earlier "do not build e-signature in-house" rule: customers sign in person on the estimator's tablet inside the CRM.
  - Evidence kept per signature: signer name and email, consent time, signed time (UTC), IP, device, the estimator who ran the session, SHA-256 of the original PDF, the signature image and the signed PDF. The signed PDF is the original pages plus a certificate page, and cannot be signed or changed again.
  - Choosing a package copies the price and deposit onto the job (deposit rule in `rules.ts`) and moves the job up to scope_presented. Editing the selected package voids the selection and any unsigned contract. A signed contract locks prices.
  - Contract terms and the consent text are DRAFT placeholders. They need review by an attorney before real customers sign.
  - Not yet handled: the FTC 3-day right-to-cancel notice for in-home sales, Missouri home-improvement and insurance-claim rules, and remote (emailed link) signing.
- 2026-10 (slice 4, deposits and payments):
  - Payments are recorded only after the contract is signed, and can never take total collected above the contract total. Payments are voided with a reason (admin or accounting), never deleted.
  - Who sees amounts: admin, accounting, and the job's own estimator. Production Managers, CSRs and crew leaders do not (a PM sees the stage only).
  - Deposit paid (payments marked deposit) >= required moves the job from contract_signed to deposit_collected. Voiding never moves a stage backward by itself; the screen warns instead.
  - Commission earned so far = rate at the job's margin applied to non-voided payments collected (`commissionEarnedCents`), shown to the own estimator, admin and accounting. Payouts and draws are a later slice.
  - Not yet handled: QuickBooks sync, a Helcim API link to verify or auto-record card payments, invoices, and commission on the separate retail upgrade scope of an insurance job.
- 2026-10 (slice 5, lead intake and call routing):
  - CSR phone intake: search by phone, name or street first; the same phone number is the same customer (matched on the 10 digits). Routing follows section 2: existing customer -> the estimator who handled them last; otherwise the Production Manager of the first division selected, preferring the property's market and falling back to any market. A CSR can assign an estimator by hand. A division with no PM creates the lead unassigned and flagged, never an error.
  - Website form leads (POST /api/leads/website, protected by a shared secret header, a honeypot and rate limits) land in a "needs review" list with a guessed market (West Plains) until a CSR confirms the market and routes them. The visitor's message is kept in integration_events.
  - Only CSR and admin can search customers and take leads. Ad spend per source per month is an admin-only settings page and feeds cost per lead and cost per win.
  - Not yet handled: DemandIQ webhook (payload format to confirm with DemandIQ), Google scheduling and Facebook integrations (source is picked by hand), appointment availability and double-booking checks, paid condition-report jobs, SMS reminders.
- 2026-10 (slice 6, commissions):
  - Every payment collected on a job with an estimator and a known margin adds one entry to an append-only commission ledger (rate and margin are snapshotted; 10% own truck, minus 1 point per full 2 points of margin under 40%). Voiding a payment adds a reversal dated the void day; a clawback after a payout lands in the next period. Admin can add a manual adjustment with a required reason. Nothing in the ledger is edited or deleted.
  - Payouts use fixed pay periods set by an admin (weekly, every other week, twice a month, or monthly; weekly and biweekly need a date a period ends on). Periods use Central time. A payout covers every unpaid entry dated on or before the period end, is allowed only after the period has ended, and happens once per estimator per period. Money is paid outside the CRM and recorded here.
  - Draws are advances recorded by accounting or admin. Payouts net outstanding draws oldest first; a draw larger than what was earned keeps its remainder. A zero or negative unpaid total pays nothing and carries forward.
  - Visibility: an estimator sees only their own statement; admin and accounting see all; PMs, CSRs and crew leaders see none. Only admin can add adjustments or change the schedule.
  - Not yet handled: QuickBooks sync of payouts, insurance upgrade scope earning its own retail commission, payroll or tax reporting (accounting should confirm how commissions are reported).
- 2026-10 (slice 7, manager reports):
  - Close rate = won / all leads created in the period, as of today. A lead is a job created in the period (paid condition reports excluded); won means the job reached contract_signed or later. Lost and open counts and a won/decided rate are shown beside it. The source_performance view now counts a signed contract as a win (it used to count any job with a contract amount, which became true as soon as a package was selected).
  - Sales = contract totals of jobs whose contract was signed in the range; a multi-division job counts fully under its first division; jobs with no estimator show as Unassigned. Cost per lead and per won job use whole calendar months because ad spend is entered monthly. All dates use Central time.
  - Visibility: admin and accounting see every report. A Production Manager sees close rate, sales and install timing for their divisions. An estimator sees their own close rate and sales. A CSR sees lead and win counts by source with no dollar amounts. Reports can be downloaded as CSV (spreadsheet formulas in names are neutralised).
  - Reports that need later slices and show "no data yet" until then: days from contract to install (needs production scheduling), AR aging (needs invoicing and closeout), outstanding depreciation (needs insurance claim tracking). Those three are queued ahead of QuickBooks sync.
- 2026-10 (multi-trade jobs, an estimate per division):
  - Each trade (division) on a job gets its own Good/Better/Best estimates, and the customer picks one package per trade. There is ONE combined contract for the job, listing each trade with a subtotal and a grand total, one signature, one deposit.
  - Every trade on the job must have a chosen package before the contract can be prepared. The job's contract, cost, special-order flag and deposit are the sum over the chosen packages, so the deposit rule (over $5,000 or special order) applies to the COMBINED total: two $3,000 trades need a deposit.
  - Commission stays on the blended job margin (combined sale vs combined cost). Per-trade commission rates are not supported because payments are not allocated to trades.
  - The estimator (or admin) can add a trade to a job or remove one until the contract is signed; removing a trade deletes its unsigned estimates and recalculates the totals. A job always keeps at least one trade. Editing a chosen package voids that trade's choice and any unsigned contract.
  - A Production Manager sees (with margin) only the scopes for the trades they manage. The combined contract summary and PDF show every trade's customer price and are readable from contract onward.
  - Reports: sales by division now split a multi-trade job across its trades by each trade's chosen package. Close rate by division still counts a lead once, under its first division. Older single-package jobs are unchanged.
- 2026-10 (slice 8, production scheduling):
  - Scheduling is per trade (division). Each trade has its own install date and crew leader. Trade status: not scheduled -> date proposed -> scheduled (confirmed with a crew leader) -> in production -> complete. The job is Scheduled when every trade is confirmed, In production when the first trade starts, and moves to Closeout when every trade is complete; stages never move backward.
  - The estimator (or admin) proposes the install date for each trade; that trade's Production Manager (or admin) assigns the crew leader and confirms it. Rescheduling is allowed until the trade starts. A crew leader booked twice on one day gets a warning, not a block.
  - Gates: the estimator can enter colors, record the materials order and propose dates only after the contract is signed and the deposit is covered (or none is required), matching the contract's promise that the deposit comes before materials are ordered. The PM can confirm only after the materials order is recorded. Colors lock once the order is recorded and never change a price.
  - The material list is built from each trade's chosen package: material lines grouped by product and color with quantities and a special-order flag; labor and other costs are left out and the list never contains a price, cost or margin. Until the Pruett link exists the purchase order is placed by hand and its number recorded in the CRM.
  - Visibility: the job's estimator and admin see the whole job; a PM sees and acts on the trades they manage; a crew leader sees only trades assigned to them (address, trade, date, material list; no prices, margin, customer name or phone) and can start and complete them. CSR and accounting have no production screens.
  - Starting a trade writes the job_stage_history row the "days from contract to install" report reads, so that report now has data. Every scheduling action is written to production_events.
  - Not yet handled: crew pay (per square, hourly on odd jobs), text-message notifications to crews (Twilio slice), calendar sync, un-scheduling a confirmed trade, and an admin screen to add crew leaders (they are created in the database; two fake ones exist in dev).
- 2026-10 (slice 9, CompanyCam photos):
  - Every new lead gets a CompanyCam project so photos exist from the first inspection. Exception: a lead from the public website form gets its project only when a CSR confirms it, so spam submissions cannot fill CompanyCam. Phone leads get theirs immediately.
  - CompanyCam never blocks or fails a lead. The project is requested after the job is saved; a failure is recorded on the job (status, short fixed error text, attempt count, next retry time) and retried automatically with growing waits (1 min, 5, 15, 1 hour, 6 hours, then daily; a rate limit honors Retry-After; a rejected token waits a day) and stops after 8 tries. Admin or the job's estimator can press Retry at any time. `npm run companycam:sync` retries stragglers; it is a dry run unless given `--apply`, so connecting a real account never pushes every old job in by accident.
  - A project is linked to exactly one job (unique index). Before creating, the CRM searches CompanyCam by street name and links an existing active project only if exactly one has the same street (ignoring Rd/Road style spelling) and 5-digit zip and no other job owns it; otherwise it creates a new one. Two syncs at once create one project (atomic claim with a lease).
  - What goes to CompanyCam: project name "Last, First - Job 24 - Roofing + Siding", the property address and the customer's name as primary contact. No phone, email, prices or margin. The access token lives only in server environment variables (`COMPANYCAM_ACCESS_TOKEN`) and is never logged or stored; call records keep the endpoint and result only.
  - Photos are fetched live when the job's production page opens (cached about a minute), thumbnails only, and are never stored in the CRM. Seen by admin, the job's estimator, a PM with a trade on the job, and a crew leader assigned to a trade (once confirmed). Admin and the job's estimator can create, link an existing project and retry; only admin can unlink. Unlinking never deletes anything in CompanyCam.
  - Built on CompanyCam's current public API (/public_api/v1: bearer token, {data, errors, meta} responses, cursor paging), replacing the legacy v2 API that CompanyCam retires in early 2027. All CompanyCam code is in `src/integrations/companycam/`. Not documented in CompanyCam's published API file, so not assumed: rate limits, whether image URLs expire, and the list of project status values (the client treats a project as active unless CompanyCam says archived or deleted). The panel hides thumbnails that fail to load and keeps the "Open in CompanyCam" link. The old creator-email setting (`COMPANYCAM_USER_EMAIL`) is gone: the new API takes the creator from the token.
  - Not handled: archiving the projects of lost jobs, uploading photos from the CRM (crews use the CompanyCam app), webhooks.
  - Token: a Personal Access Token (Read & Write, 90-day expiry, named "A&A CRM") made in CompanyCam under Company Settings > Access Tokens (https://app.companycam.com/access-keys; the old /access_tokens address no longer exists). Verified 2026-10-05 that it works on the current API (token check, search and project list all returned 200). It must be renewed before it expires (Jan 3, 2027); an expired token shows up as an auth error on the job and the retry tool.
- 2026-10 (slice 10, closeout and invoicing):
  - The closeout punchlist is built when a person first opens a job that is in closeout (every trade complete): five whole-job items plus a few per trade on the job, with English and Russian labels. **The starter list is a draft for AL to edit, and the Russian labels need a Russian speaker's review.** Each job's list can be changed (add, rename, remove) until the job is invoiced, then it is locked.
  - Who ticks items: admin, the job's estimator, the PM of the trade (and whole-job items), and the crew leader assigned to the trade once it is confirmed (their trade's items and the whole-job items). Crew leaders can tick but not add, rename or remove, and never see prices or the customer's name. Accounting sees the whole list read-only. CSRs and other estimators have no access. Someone who may not see an item is told it doesn't exist.
  - Invoice gate: the job is in closeout (or already invoiced with its invoice voided), the contract is signed, and the punchlist exists with every item done. An empty list does not count as finished.
  - Invoice: a frozen snapshot of the contract total, payments collected so far (voided payments excluded) and the balance. Terms are due on receipt (the due date is the invoice date, in Central time). Invoices are numbered in sequence from 1001, issued only by admin and accounting, and never deleted. A job has one live invoice; a mistaken one is voided with a reason (admin or accounting, only while the job is invoiced) and a new one issued. Insurance jobs are invoiced for the full contract total; carrier checks recorded as payments reduce the balance.
  - Stages: issuing moves the job to invoiced, which is the stage-history row the AR aging report ages from (reissuing after a void does not add another). A job with nothing owed goes straight on to paid in full. Recording the payment that brings an invoiced job's balance to zero moves it to paid in full. Voiding a payment never moves a stage backward; the screen flags it for a person.
  - Delivery: the PDF is emailed from the CRM to the customer's email on file (or an address typed in) and a copy is kept. The result of the email is recorded apart from issuing, so a failed email never loses the invoice and can be sent again; nothing from the email provider is stored. The PDF is only served to signed-in people with rights to the job (admin, accounting, the job's estimator, a PM with a trade on the job). It shows the total, payments, balance and terms and never any cost, margin or commission.
  - AR aging now fills in from invoiced jobs. **The "how to pay" line on the invoice (checks payable to A&A Exterior Group, or contact the office for card) is a placeholder for AL to confirm.**
  - Not handled: progress or partial invoices, late fees, an online pay link, a customer portal, the `depreciation_pending` stage (insurance claim tracking slice), QuickBooks sync of invoices, and re-invoicing after a change order (the change-order slice).
