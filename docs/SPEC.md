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
- 2026-10 (slice 11 part A, measurements and the Hover link):
  - A job has measurements: roof area (sq ft), facets, a pitch table, ridges and hips, valleys, rakes, eaves, flashing and step flashing (feet, to a tenth), and siding area. They come from Hover or are typed in, and every set is kept: a re-measure adds a row and the newest is current. Roofing squares are area / 100; the screen also shows squares with 5, 10, 15 and 20 percent waste. Numbers are checked (nothing negative, zero roof area, or absurdly large such as a roof over 200,000 sq ft) and anything out of range is refused, never stored.
  - Admin and the job's own estimator can search Hover, import, or type measurements, **until the contract is signed**; then they lock (the scope and contract are built from them). A Production Manager with a trade on the job can view. CSRs, accounting, crew leaders and other estimators have no access.
  - Hover link: the CRM signs in to Hover once, when an admin approves access in the browser (Settings, Hover, "Connect Hover"). Hover's access token lasts 2 hours and its refresh token **changes every time it is used**, so refreshes take turns (a database lock), the new token is saved before anyone else can read, and a refused refresh token marks Hover "needs to be connected again" instead of being retried. Tokens are stored encrypted (AES-256-GCM, key `INTEGRATION_KEY` in the server environment, never in git) and never sent to a screen or written to a log. An estimator finds the property by searching Hover (default: the job's street), sees which Hover job has the same address, and can import only a finished model Hover itself lists for that search.
  - Verified against Hover's published docs: the OAuth steps and URLs, the job list (`GET /api/v3/jobs`), and the measurements JSON (`/api/v3/models/{id}/artifacts/measurements.json?version=full_json`) with its roof and siding fields. Tested so far only against a fake Hover server built from those docs, not Hover itself. Not documented, so not assumed: rate limits, whether the list returns the newest model last (the CRM picks the last finished model), and which Hover plans include API access (Hover says integrations must be enabled on the account).
  - Credentials (`HOVER_CLIENT_ID`, `HOVER_CLIENT_SECRET`, `HOVER_REDIRECT_URI`) must come from Hover; until they are in `.env` the Hover search shows "not connected" and the estimator types measurements in by hand, which always works.
- 2026-10 (slice 11 part B, roofing scope built from measurements):
  - "Build scopes" on the measurements panel creates the Good, Better and Best roofing scopes of work from the job's current measurements and the **roofing assembly settings**. It goes through the same code as a hand-built scope: the CRM computes every price (materials at the Pruett Builder price, the customer price from the target margin, 40% by default), and the client sends no prices. The estimator then edits any line in the normal builder. Available to admin and the job's own estimator before the contract is signed; roofing only for now (siding and gutters come later the same way).
  - Quantities (`src/lib/estimating/roofing.ts`, the only place these formulas live; they are quantities, not money, so `rules.ts` is untouched): shingles = roofing squares plus the waste allowance (0 to 30%, default 10%); starter and drip edge from eaves plus rakes; ridge cap from ridges plus hips; underlayment and nails from squares with waste; ice and water shield from a 3 ft strip along eaves and valleys. Every material is rounded **up** to whole units you can buy (an exact fit is not rounded up). Labor is on measured area with no waste: tear-off and install in squares to two decimals, ridge/hip and valley labor in feet rounded up, and a steep labor line for the part of the roof at 8/12 or steeper. Hover does not measure pipe boots or vents, so those stay manual.
  - **The coverage figures (105 ft of starter per bundle, 33 ft of ridge cap, 10 squares of underlayment per roll, 200 sq ft of ice and water per roll, 10 ft of drip edge, 1.5 squares per box of nails) are common rules of thumb, not A&A's.** The admin sets the real ones per package under Settings, Roofing assemblies, along with which catalog product fills each material in Good, Better and Best and the labor lines with their rates. A blank coverage uses the default. The dev database has sample rows (marked "sample rate"); production starts empty.
  - Never guessed: a material with no product set, a labor line with no rate, or a role with nothing to do on this roof is left out and reported to the estimator. If nothing usable is set up the build is refused and says so. All three tiers are priced before anything is saved, so one bad tier saves nothing.
  - Hand-built work is never overwritten by accident: if roofing scopes already have lines, the build asks first and replaces them only when told to. Replacing the package the customer picked clears that choice, exactly as editing it would. After the contract is signed the scopes are locked.
  - Labor and other scope lines now carry a unit (sq, lf, ea; 1 to 8 letters, default ea) so a work order can read "42 sq". The scope builder has a unit box on those lines. Material lines keep the catalog product's unit.
- 2026-10 (slice 11 part C, colors at signing and work orders):
  - **Colors are entered right after the contract is signed**, not after the deposit. The job's estimator (or admin) enters them on the production page; ordering materials, scheduling and confirming trades still wait for the deposit exactly as before. This replaces the earlier rule that locked colors until the deposit was covered. Colors lock once the materials order is recorded.
  - When a contract is signed the CRM makes a **draft work order for each trade** from that trade's chosen package (the labor lines and other costs, with quantities and units; materials are left out) and emails the job's estimator that colors are needed. Both are best effort: the signature stands whatever happens, and a failure is covered by the estimator's "Create work orders" button (safe to press again) and the jobs list's "Colors needed (N)" flag, which shows for admin and the job's own estimator until every material line has a color.
  - A work order has **no price, cost, rate or margin anywhere** (the tables have no such columns), and its PDF shows the address, never the customer's name, phone or email. It carries: tasks with quantity and unit, an optional note per task, notes for the crew, the install date and crew leader once set, and the trade's materials with their colors.
  - The estimator reviews the draft: edits the crew notes, adds a note to any task, and can add tasks of their own (such as "pull the permit"). Tasks that came from the signed scope can be annotated but never removed or changed, so the work order always matches what the customer signed. Up to 60 tasks.
  - **Issuing needs every material line of that trade to have a color**, and freezes the task list and notes. Admin only can reopen an issued order, and only before the crew starts the trade. Admin and the job's estimator create, edit and issue; the trade's PM can see drafts and issued orders; a crew leader sees an order only once it is issued AND the trade is confirmed and assigned to them (never a draft, never another crew's trade). CSRs, accounting and other estimators have no access. The PDF is only served to those same people, never as a public link.
  - Not handled yet: crew pay on the work order (left off by decision), crew leaders marking tasks done, notifying a crew by text when an order is issued (Twilio slice), and re-issuing after a change order (change-order slice).
- 2026-10 (going live on Railway, and what the real Hover taught us):
  - **Hosting:** the CRM runs as the `aa-crm` service in the `brilliant-surprise` project, `production` environment, deployed from GitHub `pruett-pos/aa-crm` branch `main`, with its own Postgres service there (private address, public access off). It starts with `npm start`, which first runs `scripts/setup-db.ts`: on an EMPTY database it creates the schema from `db/setup-production.sql` (schema + migrations 002 to 015 + the first admin) and does nothing once the `users` table exists. **A new migration must be added to `db/setup-production.sql` for fresh databases AND applied by hand to production** (this step never changes an existing database). Railway's pre-deploy setting did not run, so the guard is in the start command.
  - Public address while the domain is pending: the generated `*.up.railway.app` address. `crm.aaqualityroofing.com` is added in Railway but its DNS lives in a Cloudflare account A&A has not found yet; `APP_URL` and `HOVER_REDIRECT_URI` must change to the final address, and so must the redirect address registered at Hover.
  - Behind Railway's proxy the app sees `https://localhost:8080`, so redirects are built by `src/lib/public-url.ts` (APP_URL, else the forwarded host), never from `req.url`.
  - **Hover facts learned from the real service:** integrations are made under Settings, Developer; the redirect address must be https (http is refused); Hover redirects to the address REGISTERED on the integration, so changing it in the CRM's `.env` alone does nothing; rate limit is 120 requests a minute or 7,200 an hour (HTTP 429); the authorize step takes only `response_type`, `client_id` and `redirect_uri` and **does not send `state` back**, so the callback requires the short-lived cookie set by "Connect Hover" (and an admin session) instead, and rejects a `state` only if one comes back and differs; authorization codes expire after 10 minutes and a code must never be pasted or shared. Resetting the secret on the Hover edit page (the form's Reset button) invalidates the old one.
  - **Product catalog screen (Settings, Product catalog, admin only):** production starts with an empty `products` table and the Pruett price sync is still last in the queue, so the admin adds the materials by hand. Fields: name, unit (1 to 8 letters), Pruett SKU or own code (unique, ignoring case; the later sync matches on it), Pruett RETAIL price (typed as dollars, stored as integer cents, above zero, at most $100,000 a unit) and a special-order flag. The screen shows what A&A pays at the Builder plan using `pruettPriceCents` in `rules.ts`. A product still used by a scope line or a roofing assembly cannot be removed (the message says so); there is no "hide" yet. No migration was needed.
  - **Hover's real measurements JSON (version 2) nests everything under `summary`** (`summary.roof.*`, `summary.area.total.siding`), not at the top level as the published example suggested. Roof pieces carry `area: null` and the number in `length`. The parser reads `summary` first and still accepts the flat shape. Found from the first live pull (the CRM logs an outline of any response it cannot read: field names and numbers, never string text). Pitch strings and the roof-versus-siding split on a real job are still unconfirmed beyond that one pull.
  - Email: until a sender domain is verified in Resend, `EMAIL_FROM` can only be Resend's test sender, which reaches only the Resend account owner's address. Customer and crew email needs a verified domain.
- 2026-11 (production-readiness foundation; details in `docs/OPERATIONS.md`):
  - **Migrations:** `npm run db:migrate` is the only way the schema changes. It applies `db/schema.sql` (as `001_schema`) and `db/migrations/NNN_*.sql` in order, each exactly once and inside its own transaction, and records them in `schema_migrations`. `--dry-run` lists what is pending. `npm start` runs it first (`scripts/migrate.ts --on-start`). It **replaces `db/setup-production.sql` and `scripts/setup-db.ts`, which are deleted**: that file was a hand-pasted copy of the schema plus every migration and had to be edited twice for each change. The earlier rule "a new migration must be added to setup-production.sql AND applied by hand to production" no longer applies: add the migration file only. Production predates the runner, so it needs the one-time baseline (`npm run db:baseline`), which marks migrations 001 to 014 as applied after checking that the objects each one creates are really there, and runs no SQL.
  - **Users and audit:** admins add users, change roles, turn people off and on, and assign a Production Manager's divisions in Settings, Users (crew leaders included). An admin cannot change their own role, turn themselves off, or change their own email, so the last admin can never be locked out by a click. Turning someone off, or changing their role, signs them out immediately and removes their Production Manager divisions (lead routing reads those rows). `audit_log` (append-only, enforced by a database trigger) records user changes in the same transaction as the change, and settings changes (products, commission schedule, ad spend, roofing assemblies, Hover connect/disconnect) right after they succeed. Settings, Audit log shows them. **Truck setting (decided by AL):** an admin switches an estimator between company truck (8% base) and own truck (10% base) on the Users screen. Admin only, shown for estimators only, and every change is audited (`user.truck_changed`: who, when, old and new). It applies only to commission on payments collected AFTER the change: each commission ledger entry snapshots its rate, margin and amount when its payment is recorded, and a void reverses that entry at its original rate, so nothing already booked is recomputed. The "earned so far" figure on a job's payments screen is now the sum of that job's ledger entries instead of a recomputation at the current setting. Leaving the estimator role clears the setting.
  - **Sign-in rate limit** now lives in Postgres (`rate_limits`) so it survives deploys. The in-memory limiter stays on the signed-in routes.
  - **Scheduled jobs** run through `scripts/run-cron.ts` (`npm run cron:pruett`, `npm run cron:companycam`): a failure exits non-zero and emails `ALERT_EMAILS`. CompanyCam's retry now fails the run when CompanyCam rejects the token (it expires every 90 days). This supersedes the bare `node ... scripts/pruett-sync.ts --apply` command above.
  - **Health and security:** `GET /api/health` (public; checks the database; ok or down only). Railway's health check uses it. Security headers and a nonce-based Content-Security-Policy are set on every response. The proxy only checks that a session cookie exists; every route and page validates the session itself, and `tests/route-guards.test.ts` fails the build if an API route has no role check.
- 2026-11 (Pruett nightly price sync; replaces the earlier retail-only, dry-run-first script that was merged as #2):
  - **Source and cost:** `GET {PRUETT_FEED_URL}/api/feed/prices?level=Builder` with `Authorization: Bearer {PRUETT_FEED_KEY}` (`PRUETT_PRICE_LEVEL`, default Builder). A&A's material cost is Pruett's `price_cents` as sent (Builder = 12% off retail); Pruett never sends its own cost. It is stored as `products.cost_cents`, with `retail_cents` kept for display. `materialUnitCostCents` in `rules.ts` is the one place that picks the cost: a synced product's `cost_cents`, otherwise (hand-entered products) retail less the Builder discount as before. Scopes use it, so a synced price flows into new and re-saved scopes; signed contracts and saved scope lines keep the cost they were priced at.
  - **Matching and what changes:** products match on Pruett SKU (ignoring case); new SKUs are added; a hand-entered product with a Pruett SKU is adopted (`source` becomes `pruett`, its id and special-order flag stay). Name, unit (letters only, 1 to 8), description2, category, vendor and vendor SKU follow Pruett. Special order is not in the feed, so it is never touched. Products added by hand that Pruett doesn't list are never deactivated. All writes go through `src/lib/catalog` (one transaction per run).
  - **Price history:** every cost or retail change writes a `product_price_history` row (old and new cost, old and new retail, time, run).
  - **Missing items:** a Pruett product missing from the feed, or marked inactive there, becomes inactive. Inactive products cannot be picked for new scope lines but stay on scopes that already use them. A new item Pruett lists as inactive is not added. A product that comes back is reactivated.
  - **Safety rule:** if the feed lists fewer than half of the currently active Pruett products, prices still update and new items still come in, but nothing is deactivated and the run is saved with a warning. Exactly half is fine. Also refused outright (run saved as an error, nothing changed): `level_not_set` ("Builder % not set in Pruett POS"), a 401/403, a feed answering for another level, and a feed whose `count` doesn't match its items (a cut-off download). A feed row with no SKU or a price that isn't whole cents is skipped with a warning, and its SKU is not treated as missing.
  - **Held moves:** a price (cost or retail) that moves more than 50% in one night is not applied for that product and is listed in the run's warning, as in the earlier script. `npm run pruett:sync -- --dry-run` shows what a run would do and writes nothing. The older env names `PRUETT_POS_API_URL` / `PRUETT_POS_API_KEY` are still read when the new ones are empty. Unlike the earlier script, the feed's `price_cents` IS stored (as `cost_cents`) because that is what A&A pays.
  - **Run log:** every run is a row in `pruett_sync_runs` (started, finished, trigger, who, seen/new/changed/deactivated, warning, error). Settings, Product catalog shows the last run and an admin-only "Sync from Pruett now" button (`/api/settings/products/sync`, admin only, audited). Two runs never overlap.
  - **Schedule:** its own Railway cron service running `npm run cron:pruett` (through `scripts/run-cron.ts`, so a failed run exits non-zero and emails `ALERT_EMAILS`), scheduled `0 7,8 * * *` UTC. Railway cron has no time zone, so `scripts/pruett-sync.ts` runs only when it is 2 AM in Central (CDT or CST) and exits quietly on the other of the two firings. The script applies changes by default; `--dry-run` previews and `--now` forces a run. Service settings are in `railway.pruett-sync.json`.
  - Migration `db/migrations/017_pruett_sync.sql` (with its signature in `src/lib/migrate/signatures.ts` and `prisma/schema.prisma`) is applied by the migration runner when the web service starts, so production gets it on deploy. `db/schema.sql` is migration 001 and is not edited. Env: `PRUETT_FEED_URL`, `PRUETT_FEED_KEY`, `PRUETT_PRICE_LEVEL`; the older `PRUETT_POS_API_URL` / `PRUETT_POS_API_KEY` are still read when those are empty.
  - Not handled: sending purchase orders to Pruett, the roofing "build scopes" tool still being able to use an inactive product already set in an assembly, and a screen for the price history (it is stored, not shown yet).
- 2026-11 (aerial roof estimate when a Free Inspection is booked):
  - **What it is:** a first look at the roof for the estimator before the visit, labelled "Aerial estimate — verify on site" everywhere. When a CSR books a lead WITH an appointment, the CRM geocodes the property address (Google Geocoding API), asks the Google Solar API for the closest building (`buildingInsights:findClosest`, HIGH imagery first, then MEDIUM, then BASE) and saves one satellite picture (Maps Static API, zoom 20, 640x640). It runs in the background after the lead is saved, exactly like the CompanyCam project, so the booking screen never waits and never fails because of Google.
  - **When it is skipped:** the feature is off; no `GOOGLE_MAPS_API_KEY`; the booking has no appointment; the job is a paid Condition Report (intake cannot create those yet, the check is there for when it can); or the property already has an estimate. "No aerial data" counts as already having one, so Google is not asked again on every later booking; an admin can press "Fetch again" on the job.
  - **Stored on the property** (`property_aerial_estimates`, one row per property): roof area in sq ft as Google measured it and after the correction factor, roofing squares to 0.1 (1 square = 100 sq ft), main pitch, number of roof segments, each segment's area, pitch and compass direction, imagery quality and date, confidence, Google's raw response, the picture, and when it was fetched. Area is the sloped roof area (Google's whole-roof figure; the segments' total when that is missing). Pitch is 12 x tan(degrees) rounded to a whole rise (26.57 degrees is 6/12); the main pitch is the one covering the most area.
  - **Confidence** follows the imagery quality: HIGH is High, MEDIUM is Medium, BASE is Low. It also drops to Low when Google could only place the address along the road instead of on the roof. To avoid measuring a neighbor's roof, an address Google can only place at the middle of a street or town, and a building more than 60 m from a rooftop address (200 m from a road-interpolated one), are marked "No aerial data". **These distance limits are a starting guess for AL to tune on rural addresses.**
  - **Failures:** no address match, no building, no usable area, or an API error all show "No aerial data" (the reason is kept for the admin and every Google call is recorded in `integration_events` by endpoint and result only: never the key, the address or coordinates). A failed call is retried at most twice for the whole estimate, and only when trying again could help (network, server error, rate limit); not found, a rejected key and a bad request are never retried. Stepping down from HIGH to MEDIUM to BASE is not a retry.
  - **Ballpark price (decided by AL):** the corrected squares plus the default waste (10%, an admin setting) go through the existing roofing assembly templates and today's price book, through the same `computeScope` and `rules.ts` as a real scope of work, and the job shows the Good / Better / Best customer prices and their range. Shown only when roofing is one of the job's trades. It is worked out when the page opens and never saved. **Edge and ridge materials are included (decided by AL):** Google measures no edges, so eaves, rakes, ridges and hips, and valleys are the admin's average feet per roofing square times the roof's squares. **The starting averages (5.0, 4.0, 2.5 and 1.0 ft per square) are rules of thumb, not A&A's**; the calibration report shows what Hover measured so the admin can replace them.
  - **Never on a contract or a material order:** the aerial estimate lives in its own table and nothing copies it into a job's measurements or a scope. Contracts, scopes built from measurements, material lists and work orders still come only from Hover or typed-in measurements; a test fails if that code ever reads the aerial estimate.
  - **Who sees it (decided by AL):** anyone signed in sees the picture, the numbers and the ballpark prices, on the new job overview page (`/jobs/[jobId]`, linked from the leads list and the jobs list) and at the top of the scope page. The overview shows the appointment and the property address but not the customer's name, phone or email. The ballpark is the customer price only: no cost or margin. This is wider than the rest of the CRM, where CSRs, Production Managers before contract and crew leaders see no prices.
  - **Admin settings (Settings, Aerial estimates):** on/off (**off until an admin turns it on**), the correction factor (50% to 150%, applied to estimates fetched from then on; saved estimates keep the factor they were fetched with), the waste percent and the four edge averages. Changes are in the audit log.
  - **Calibration report (same page, admin only):** every property that has both an aerial estimate and a Hover measurement (the newest Hover one; typed-in measurements are not used): aerial squares, Hover squares, the difference, the average error (ignoring direction), the average difference (direction kept), the correction factor that would have made the totals match, and Hover's average edge lengths per square. It always compares Google's uncorrected area, so a factor already in force is not counted twice.
  - **Picture storage (decided by AL):** the satellite picture is saved in the database and served only to signed-in users. **Google's Maps Platform terms restrict storing map images; AL should confirm this use with Google's terms before real use.**
  - **Not verified against Google:** Google's documentation site could not be reached while this was built and no live call has been made (tests use a fake Google, as required). To confirm on the first real fetch: the response field names (`solarPotential.wholeRoofStats.areaMeters2`, `roofSegmentStats[].pitchDegrees / azimuthDegrees / stats.areaMeters2`, `imageryQuality`, `imageryDate`, `center`), that "no building" answers HTTP 404, and whether BASE imagery needs an extra request parameter. The key needs the Geocoding, Solar and Maps Static APIs enabled, and Google bills each call.
  - Migration `db/migrations/018_aerial_estimates.sql` (two new tables, nothing existing is changed) is applied by the migration runner when the web service starts. Env: `GOOGLE_MAPS_API_KEY`. Code: `src/integrations/google-solar/` (the only place that talks to Google) and `src/lib/aerial/`.
  - Not handled: fetching for leads booked before the feature was on (an admin can press "Fetch again" on each), adding an appointment to an existing lead (the CRM has no screen for that yet), a scheduled sweep for fetches interrupted by a restart (the next booking or "Fetch again" picks them up), and drawing the segments on the picture.
