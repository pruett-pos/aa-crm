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
