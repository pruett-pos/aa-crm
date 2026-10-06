-- A&A CRM reference schema (PostgreSQL 14+). Money = integer cents. Rates = basis points.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role   AS ENUM ('admin','csr','estimator','production_manager','crew_leader','accounting');
CREATE TYPE division    AS ENUM ('roofing','siding','gutters','windows_doors','insulation','spray_foam','commercial');
CREATE TYPE market      AS ENUM ('west_plains','springfield','nw_arkansas');
CREATE TYPE job_type    AS ENUM ('retail','insurance','condition_report');
CREATE TYPE insured_type AS ENUM ('deductible_only','upgrade');
CREATE TYPE lead_source AS ENUM ('phone','demandiq','website','google_scheduling','facebook','referral','canvassing','other');
CREATE TYPE job_stage   AS ENUM (
  'new_lead','appointment_set','inspected','contingency_signed','claim_approved',
  'scope_presented','contract_signed','deposit_collected','materials_ordered',
  'scheduled','in_production','closeout_punchlist','invoiced',
  'depreciation_pending','paid_in_full','lost','cancelled_after_approval');
CREATE TYPE package_tier AS ENUM ('good','better','best');
CREATE TYPE payment_method AS ENUM ('check','card','ach','cash','insurance_check','financing');

-- People ------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     text NOT NULL,
  email         text NOT NULL UNIQUE,
  phone         text,
  role          user_role NOT NULL,
  market        market,
  own_truck     boolean NOT NULL DEFAULT false,   -- estimator commission 10% vs 8%
  preferred_lang text NOT NULL DEFAULT 'en',      -- 'en' | 'ru'
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Auth: magic-link tokens and sessions. Only SHA-256 hashes are stored, never raw values.
CREATE TABLE login_tokens (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_tokens_user_idx ON login_tokens (user_id);

CREATE TABLE sessions (
  session_hash text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Call routing: one PM per division per market
CREATE TABLE division_managers (
  division  division NOT NULL,
  market    market   NOT NULL,
  user_id   uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (division, market)
);

CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name    text NOT NULL,
  last_name     text NOT NULL,
  phone         text,
  email         text,
  last_estimator_id uuid REFERENCES users(id),     -- drives call routing
  phone_digits  text,                              -- 10 digits, for search and de-duplication
  qbo_customer_id   text,
  leap_id       text,                              -- for migration traceability
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_phone_idx ON customers (phone);
CREATE INDEX customers_phone_digits_idx ON customers (phone_digits);

CREATE TABLE properties (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  street      text NOT NULL,
  city        text NOT NULL,
  state       text NOT NULL DEFAULT 'MO',
  zip         text NOT NULL,
  market      market NOT NULL,
  hover_job_id text,
  companycam_project_id text
);

-- Marketing spend (so cost per lead / per win is always populated) --------
CREATE TABLE marketing_spend (
  source      lead_source NOT NULL,
  month       date NOT NULL,           -- first day of month
  spend_cents bigint NOT NULL CHECK (spend_cents >= 0),
  PRIMARY KEY (source, month)
);

-- Jobs --------------------------------------------------------------------
CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_number    serial UNIQUE,
  property_id   uuid NOT NULL REFERENCES properties(id),
  job_type      job_type NOT NULL,
  divisions     division[] NOT NULL CHECK (cardinality(divisions) > 0),
  stage         job_stage NOT NULL DEFAULT 'new_lead',
  source        lead_source NOT NULL,
  online_quote  boolean NOT NULL DEFAULT false,   -- came via DemandIQ instant quote
  needs_review  boolean NOT NULL DEFAULT false,   -- online lead waiting for a CSR to confirm market and routing
  created_by    uuid REFERENCES users(id),
  estimator_id  uuid REFERENCES users(id),
  production_manager_id uuid REFERENCES users(id),
  crew_leader_id uuid REFERENCES users(id),
  appointment_at timestamptz,
  install_date   date,                             -- earliest trade install date, kept in step by production scheduling
  materials_ordered_at timestamptz,                -- when the materials order was recorded
  materials_ordered_by uuid REFERENCES users(id),
  po_reference   text,                             -- purchase order number (entered by hand until the Pruett link exists)
  -- CompanyCam link. Photos stay in CompanyCam; the CRM stores only which project belongs to the job.
  companycam_project_id  text,
  companycam_project_url text,
  companycam_status      text NOT NULL DEFAULT 'none' CHECK (companycam_status IN ('none','pending','linked','error')),
  companycam_link_method text CHECK (companycam_link_method IN ('created','auto_match','manual')),
  companycam_attempts    integer NOT NULL DEFAULT 0,
  companycam_next_attempt_at timestamptz,        -- retry time after an error, or the lease while a sync is running
  companycam_error       text,
  lost_reason    text,
  contract_cents bigint,                          -- set at contract_signed
  cost_cents     bigint,                          -- est. materials + labor
  has_special_order boolean NOT NULL DEFAULT false,
  deposit_required_cents bigint NOT NULL DEFAULT 0, -- computed by rules.ts
  qbo_invoice_id text,
  leap_id        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (stage <> 'lost' OR lost_reason IS NOT NULL)
);
CREATE INDEX jobs_stage_idx ON jobs (stage);
CREATE INDEX jobs_estimator_idx ON jobs (estimator_id);
-- A CompanyCam project can belong to only one job.
CREATE UNIQUE INDEX jobs_companycam_project_idx ON jobs (companycam_project_id) WHERE companycam_project_id IS NOT NULL;

CREATE TABLE job_stage_history (
  id         bigserial PRIMARY KEY,
  job_id     uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_stage job_stage,
  to_stage   job_stage NOT NULL,
  changed_by uuid REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- Insurance ---------------------------------------------------------------
CREATE TABLE insurance_claims (
  job_id          uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  insured_type    insured_type,
  carrier         text,
  claim_number    text,
  adjuster_name   text,
  adjuster_phone  text,
  adjuster_meeting_at timestamptz,
  contingency_signed_at timestamptz,
  approved_at     timestamptz,
  rcv_cents       bigint,
  acv_cents       bigint,
  depreciation_cents bigint,
  deductible_cents   bigint,
  depreciation_received_at timestamptz,
  cancellation_fee_cents bigint    -- set if homeowner walks after approval
);

CREATE TABLE supplements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  description text NOT NULL,
  amount_cents bigint NOT NULL,
  status      text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','denied')),
  submitted_at timestamptz NOT NULL DEFAULT now()
);

-- Catalog & scopes ---------------------------------------------------------
CREATE TABLE products (               -- mirrored nightly from Pruett POS
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pruett_sku    text NOT NULL UNIQUE,
  name          text NOT NULL,
  unit          text NOT NULL,          -- sq, bundle, ea, lf...
  retail_cents  bigint NOT NULL,
  special_order boolean NOT NULL DEFAULT false,
  synced_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scopes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  division    division NOT NULL,        -- the trade this estimate is for; one set of packages per trade
  tier        package_tier NOT NULL,
  title       text NOT NULL,           -- e.g. "Malarkey Highlander"
  sale_cents  bigint NOT NULL DEFAULT 0,
  cost_cents  bigint NOT NULL DEFAULT 0,        -- recomputed by the server via rules.ts
  target_margin_bps integer NOT NULL DEFAULT 4000 CHECK (target_margin_bps BETWEEN 0 AND 9500),
  selected    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, division, tier)
);
-- One chosen package per trade; the job's contract is the sum of the chosen packages.
CREATE UNIQUE INDEX one_selected_scope_per_division ON scopes (job_id, division) WHERE selected;

CREATE TABLE scope_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id    uuid NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'material' CHECK (kind IN ('material','labor','misc')),
  sort_order  integer NOT NULL DEFAULT 0,
  product_id  uuid REFERENCES products(id),  -- null for labor / misc
  description text NOT NULL,
  quantity    numeric(12,2) NOT NULL,
  unit_cost_cents bigint NOT NULL,           -- Pruett Builder price or labor rate
  unit_price_cents bigint NOT NULL,          -- what the customer pays
  color       text
);

CREATE TABLE change_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id),     -- crew leader
  description text NOT NULL,
  amount_cents bigint NOT NULL,
  signed_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Documents & money ---------------------------------------------------------
CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('contingency','contract','change_order','condition_report','hover','xactimate','other')),
  file_url    text NOT NULL,
  esign_envelope_id text,                     -- unused: signing is built into the CRM
  signer_email text,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','signed','declined','cancelled')),
  file_data   bytea,                          -- current PDF (signed once signed); file_url is our authenticated file route
  unsigned_data bytea,                        -- the PDF the customer was shown, kept as signed
  unsigned_sha256 text,
  signed_sha256 text,
  signed_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_job_idx ON documents (job_id);
-- At most one live contract per job.
CREATE UNIQUE INDEX one_live_contract ON documents (job_id) WHERE kind = 'contract' AND status <> 'cancelled';

-- One row per in-person signature, with the audit trail.
CREATE TABLE contract_signatures (
  document_id   uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  signer_name   text NOT NULL,
  signer_email  text,
  consent_at    timestamptz NOT NULL,
  signed_at     timestamptz NOT NULL,
  ip            text,
  user_agent    text,
  signature_png bytea NOT NULL,
  signature_sha256 text NOT NULL,
  signed_by_user_id uuid REFERENCES users(id),  -- the estimator who ran the session
  method        text NOT NULL DEFAULT 'in_person' CHECK (method IN ('in_person'))
);

CREATE TABLE payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method      payment_method NOT NULL,
  is_deposit  boolean NOT NULL DEFAULT false,
  is_depreciation boolean NOT NULL DEFAULT false,
  collected_by uuid REFERENCES users(id),
  check_photo_url text,                       -- our authenticated photo route, not a public link
  qbo_payment_id text,
  received_at timestamptz NOT NULL DEFAULT now(),
  reference   text,                           -- check number, or Helcim transaction number for cards
  notes       text,
  check_photo_data bytea,
  check_photo_mime text,
  voided_at   timestamptz,                    -- payments are voided, never deleted
  voided_by   uuid REFERENCES users(id),
  void_reason text,
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX payments_job_idx ON payments (job_id);

-- Commission ----------------------------------------------------------------
CREATE TABLE commission_settings (       -- single row: the pay schedule. Payouts are blocked until it is set.
  id          smallint PRIMARY KEY CHECK (id = 1),
  cadence     text NOT NULL CHECK (cadence IN ('weekly','biweekly','semimonthly','monthly')),
  anchor_date date,                       -- a date a period ENDS on; used by weekly and biweekly
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (cadence NOT IN ('weekly','biweekly') OR anchor_date IS NOT NULL)
);

CREATE TABLE commission_draws (          -- advances against future commission
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimator_id uuid NOT NULL REFERENCES users(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  paid_on     date NOT NULL,
  applied_cents bigint NOT NULL DEFAULT 0, -- how much payouts have absorbed so far
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (applied_cents >= 0 AND applied_cents <= amount_cents)
);

CREATE TABLE commission_runs (           -- one payout per estimator per pay period
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimator_id uuid NOT NULL REFERENCES users(id),
  period_start date NOT NULL,
  period_end  date NOT NULL,
  gross_cents bigint NOT NULL,             -- unpaid commission paid out in this run
  draws_applied_cents bigint NOT NULL,
  net_cents   bigint NOT NULL,             -- gross - draws applied: what is actually paid
  paid_on     date NOT NULL,
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (estimator_id, period_end),
  CHECK (net_cents = gross_cents - draws_applied_cents)
);

CREATE TABLE commission_draw_applications (
  run_id      uuid NOT NULL REFERENCES commission_runs(id),
  draw_id     uuid NOT NULL REFERENCES commission_draws(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  PRIMARY KEY (run_id, draw_id)
);

-- The commission ledger. Append-only: entries are never edited or deleted.
-- earned = one per payment collected; reversal = a voided payment; adjustment = manual, with a reason.
CREATE TABLE commission_payouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimator_id uuid NOT NULL REFERENCES users(id),
  job_id      uuid REFERENCES jobs(id),
  payment_id  uuid REFERENCES payments(id),
  kind        text NOT NULL DEFAULT 'earned' CHECK (kind IN ('earned','reversal','adjustment')),
  rate_bps    integer,
  margin_bps  integer,
  amount_cents bigint NOT NULL,            -- negative for reversals and clawbacks
  entry_date  date NOT NULL,               -- local (Central) date; decides which pay period it belongs to
  run_id      uuid REFERENCES commission_runs(id),
  paid_on     date,
  note        text,
  created_by  uuid REFERENCES users(id),     -- who made a manual adjustment
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'adjustment' OR payment_id IS NOT NULL),
  CHECK (kind <> 'adjustment' OR (note IS NOT NULL AND length(trim(note)) >= 3)),
  CHECK (kind <> 'earned' OR (rate_bps IS NOT NULL AND margin_bps IS NOT NULL)),
  CHECK ((run_id IS NULL) = (paid_on IS NULL))
);
CREATE UNIQUE INDEX one_earned_per_payment   ON commission_payouts (payment_id) WHERE kind = 'earned';
CREATE UNIQUE INDEX one_reversal_per_payment ON commission_payouts (payment_id) WHERE kind = 'reversal';
CREATE INDEX commission_unpaid_idx ON commission_payouts (estimator_id, entry_date) WHERE run_id IS NULL;
-- Production scheduling ------------------------------------------------------
-- One row per job and trade (division). A trade with no row yet is "not scheduled".
CREATE TABLE production_trades (
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  division      division NOT NULL,
  status        text NOT NULL DEFAULT 'not_scheduled' CHECK (status IN ('not_scheduled','proposed','scheduled','in_production','complete')),
  install_date  date,
  crew_leader_id uuid REFERENCES users(id),
  proposed_by   uuid REFERENCES users(id),      -- the estimator (or admin) who proposed the date
  confirmed_by  uuid REFERENCES users(id),      -- the trade's Production Manager (or admin) who assigned the crew
  started_at    timestamptz,
  completed_at  timestamptz,
  notes         text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, division),
  CHECK (status NOT IN ('scheduled','in_production','complete') OR (install_date IS NOT NULL AND crew_leader_id IS NOT NULL))
);
CREATE INDEX production_trades_crew_idx ON production_trades (crew_leader_id, install_date);
CREATE INDEX production_trades_date_idx ON production_trades (install_date);

-- Audit log of every scheduling action.
CREATE TABLE production_events (
  id          bigserial PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  division    division,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_events_job_idx ON production_events (job_id, created_at);
-- Closeout --------------------------------------------------------------------
CREATE TABLE punchlist_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  division    division,                      -- the trade this item belongs to; null = the whole job
  label_en    text NOT NULL,
  label_ru    text,
  sort_order  integer NOT NULL DEFAULT 0,
  done        boolean NOT NULL DEFAULT false,
  done_by     uuid REFERENCES users(id),
  done_at     timestamptz,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX punchlist_items_job_idx ON punchlist_items (job_id, sort_order);

-- Invoices: a frozen snapshot of what was owed when it was issued (terms: due on receipt). Never deleted; a mistake is voided.
CREATE SEQUENCE invoice_number_seq START 1001;
CREATE TABLE invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         uuid NOT NULL REFERENCES jobs(id),
  invoice_number integer NOT NULL UNIQUE DEFAULT nextval('invoice_number_seq'),
  issued_at      timestamptz NOT NULL DEFAULT now(),
  due_on         date NOT NULL,
  contract_cents bigint NOT NULL CHECK (contract_cents >= 0),
  paid_cents     bigint NOT NULL CHECK (paid_cents >= 0),
  balance_cents  bigint NOT NULL CHECK (balance_cents >= 0),
  status         text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
  issued_by      uuid REFERENCES users(id),
  pdf_data       bytea NOT NULL,
  pdf_sha256     text NOT NULL,
  emailed_to     text,
  emailed_at     timestamptz,
  email_status   text CHECK (email_status IN ('sent','failed')),
  email_error    text,
  voided_at      timestamptz,
  voided_by      uuid REFERENCES users(id),
  void_reason    text,
  CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX invoices_job_idx ON invoices (job_id);
CREATE UNIQUE INDEX invoices_one_live_idx ON invoices (job_id) WHERE status = 'issued';

-- Integration log (DemandIQ, QBO, Pruett sync, e-sign webhooks) -----------
CREATE TABLE integration_events (
  id          bigserial PRIMARY KEY,
  system      text NOT NULL,
  direction   text NOT NULL CHECK (direction IN ('in','out')),
  status      text NOT NULL CHECK (status IN ('ok','error','retrying')),
  payload     jsonb,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Reporting view: close rate and cost per win by source -------------------
-- A win is a signed contract: the job reached contract_signed or later. (A contract AMOUNT exists as soon as a
-- package is selected, so it is not a win signal.) Months are Central time, matching the app's reports.
CREATE VIEW source_performance AS
SELECT j.source,
       date_trunc('month', j.created_at AT TIME ZONE 'America/Chicago')::date AS month,
       count(*)                                         AS leads,
       count(*) FILTER (WHERE j.stage IN ('contract_signed','deposit_collected','materials_ordered','scheduled',
                                           'in_production','closeout_punchlist','invoiced','depreciation_pending','paid_in_full')) AS wins,
       round(100.0 * count(*) FILTER (WHERE j.stage IN ('contract_signed','deposit_collected','materials_ordered','scheduled',
                                           'in_production','closeout_punchlist','invoiced','depreciation_pending','paid_in_full'))
             / nullif(count(*),0), 1) AS close_rate_pct,
       max(ms.spend_cents) / nullif(count(*),0)         AS cost_per_lead_cents,
       max(ms.spend_cents) / nullif(count(*) FILTER (WHERE j.stage IN ('contract_signed','deposit_collected','materials_ordered','scheduled',
                                           'in_production','closeout_punchlist','invoiced','depreciation_pending','paid_in_full')),0) AS cost_per_win_cents
FROM jobs j
LEFT JOIN marketing_spend ms
  ON ms.source = j.source AND ms.month = date_trunc('month', j.created_at AT TIME ZONE 'America/Chicago')::date
WHERE j.job_type <> 'condition_report'
GROUP BY 1, 2;
CREATE INDEX job_stage_history_stage_idx ON job_stage_history (to_stage, changed_at);