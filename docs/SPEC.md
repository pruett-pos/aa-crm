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
- Customer picks a package → contract generated → e-signed (Dropbox Sign API; do not build e-signature in-house).

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
- Estimators can record field payments (check/card) with photo of check.
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
| E-signature | out/in | 1 |
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
  5. E-signature vendor = Dropbox Sign. Build under `src/integrations/dropbox-sign/`.
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
