-- A&A CRM production setup. Run ONCE on an EMPTY database. Generated from db/schema.sql + db/migrations in order.
BEGIN;
-- ===== db/schema.sql =====
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
  color       text,
  unit            text                                 -- labor and other lines: sq, lf, ea...; materials use the product's unit
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

-- Measurements for a job: from Hover or typed in. A re-measure adds a row; the newest row is the current one.
-- Areas are whole square feet; lengths are tenths of a foot (so 123.4 ft is 1234).
CREATE TABLE job_measurements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source             text NOT NULL CHECK (source IN ('hover','manual')),
  hover_job_id       text,
  hover_model_id     text,
  roof_area_sqft     integer NOT NULL CHECK (roof_area_sqft BETWEEN 0 AND 200000),
  facets             integer CHECK (facets IS NULL OR facets BETWEEN 0 AND 5000),
  pitches            jsonb NOT NULL DEFAULT '[]'::jsonb,
  ridges_hips_ft10   integer NOT NULL DEFAULT 0 CHECK (ridges_hips_ft10 BETWEEN 0 AND 5000000),
  valleys_ft10       integer NOT NULL DEFAULT 0 CHECK (valleys_ft10 BETWEEN 0 AND 5000000),
  rakes_ft10         integer NOT NULL DEFAULT 0 CHECK (rakes_ft10 BETWEEN 0 AND 5000000),
  eaves_ft10         integer NOT NULL DEFAULT 0 CHECK (eaves_ft10 BETWEEN 0 AND 5000000),
  flashing_ft10      integer NOT NULL DEFAULT 0 CHECK (flashing_ft10 BETWEEN 0 AND 5000000),
  step_flashing_ft10 integer NOT NULL DEFAULT 0 CHECK (step_flashing_ft10 BETWEEN 0 AND 5000000),
  siding_area_sqft   integer CHECK (siding_area_sqft IS NULL OR siding_area_sqft BETWEEN 0 AND 500000),
  raw                jsonb,
  note               text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_measurements_job_idx ON job_measurements (job_id, created_at DESC);

-- OAuth tokens for outside systems (Hover). Tokens are stored ENCRYPTED (AES-256-GCM, key in the server environment); the
-- plain text never touches the database. One row per system.
CREATE TABLE integration_credentials (
  system             text PRIMARY KEY,
  access_token_enc   text NOT NULL,
  refresh_token_enc  text NOT NULL,
  expires_at         timestamptz NOT NULL,
  owner_id           text,
  status             text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','needs_reconnect')),
  connected_by       uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Roofing assembly settings: for each package tier, which catalog product fills each material role (with how much one unit
-- covers) and which labor lines go on the scope (with a cost rate). Edited by an admin. Sample rows for a dev database
-- live in db/seed_assemblies.sql; production starts empty and an admin fills it in.
CREATE TABLE roofing_assembly_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier          text NOT NULL CHECK (tier IN ('good','better','best')),
  role          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('material','labor')),
  product_id    uuid REFERENCES products(id),
  description   text,
  unit          text,
  coverage      numeric(10,2) CHECK (coverage IS NULL OR coverage > 0),
  unit_cost_cents bigint CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  sort_order    integer NOT NULL DEFAULT 0,
  enabled       boolean NOT NULL DEFAULT true,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tier, role)
);

-- A work order is what a crew works from: the labor tasks of the signed scope, with quantities and units. There is deliberately
-- NO price, cost, rate or margin column on either table, so money can never reach a crew's copy.

-- One work order per trade per job. It starts as a draft made from the signed scope; the estimator reviews it, adds notes
-- and issues it. Issuing freezes the task list.
CREATE TABLE work_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  division    division NOT NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued')),
  notes       text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  issued_by   uuid REFERENCES users(id),
  issued_at   timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, division),
  CHECK ((status = 'issued') = (issued_at IS NOT NULL))
);

CREATE TABLE work_order_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id  uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  sort_order     integer NOT NULL DEFAULT 0,
  source_item_id uuid REFERENCES scope_items(id) ON DELETE SET NULL,   -- the scope line it came from; null = added by hand
  description    text NOT NULL,
  quantity       numeric(12,2) NOT NULL CHECK (quantity > 0),
  unit           text NOT NULL DEFAULT 'ea',
  note           text
);
CREATE INDEX work_order_lines_order_idx ON work_order_lines (work_order_id, sort_order);

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
-- ===== db/migrations/002_scope_builder.sql =====
-- Slice 2 (scope builder). For databases created before these columns were in schema.sql.
-- Safe to re-run. Dev databases only; review before running anywhere else.
ALTER TABLE scopes ADD COLUMN IF NOT EXISTS cost_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE scopes ADD COLUMN IF NOT EXISTS target_margin_bps integer NOT NULL DEFAULT 4000;
DO $$ BEGIN
  ALTER TABLE scopes ADD CONSTRAINT scopes_target_margin_range CHECK (target_margin_bps BETWEEN 0 AND 9500);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE scope_items ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'material';
ALTER TABLE scope_items ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE scope_items ADD CONSTRAINT scope_items_kind_check CHECK (kind IN ('material','labor','misc'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== db/migrations/003_contracts.sql =====
-- Slice 3 (contract flow, signing built into the CRM). For databases created before these
-- objects were in schema.sql. Safe to re-run. Dev databases only; review before running elsewhere.
ALTER TABLE documents DROP COLUMN IF EXISTS esign_signature_id;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS signer_email text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_data bytea;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS unsigned_data bytea;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS unsigned_sha256 text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS signed_sha256 text;
DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT documents_status_check
    CHECK (status IN ('draft','sent','signed','declined','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS documents_job_idx ON documents (job_id);
DROP INDEX IF EXISTS documents_envelope_idx;
CREATE UNIQUE INDEX IF NOT EXISTS one_live_contract ON documents (job_id) WHERE kind = 'contract' AND status <> 'cancelled';

CREATE TABLE IF NOT EXISTS contract_signatures (
  document_id   uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  signer_name   text NOT NULL,
  signer_email  text,
  consent_at    timestamptz NOT NULL,
  signed_at     timestamptz NOT NULL,
  ip            text,
  user_agent    text,
  signature_png bytea NOT NULL,
  signature_sha256 text NOT NULL,
  signed_by_user_id uuid REFERENCES users(id),
  method        text NOT NULL DEFAULT 'in_person' CHECK (method IN ('in_person'))
);

-- ===== db/migrations/004_payments.sql =====
-- Slice 4 (deposits and payments). For databases created before these columns were in schema.sql.
-- Safe to re-run. Dev databases only; review before running elsewhere.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS check_photo_data bytea;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS check_photo_mime text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_by uuid REFERENCES users(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS void_reason text;
DO $$ BEGIN
  ALTER TABLE payments ADD CONSTRAINT payments_void_consistent CHECK ((voided_at IS NULL) = (void_reason IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS payments_job_idx ON payments (job_id);

-- ===== db/migrations/005_leads.sql =====
-- Slice 5 (lead intake and routing). For databases created before these columns were in schema.sql.
-- Safe to re-run. Dev databases only; review before running elsewhere.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_digits text;
UPDATE customers SET phone_digits = right(regexp_replace(phone, '\D', '', 'g'), 10)
  WHERE phone IS NOT NULL AND phone_digits IS NULL AND length(regexp_replace(phone, '\D', '', 'g')) >= 10;
CREATE INDEX IF NOT EXISTS customers_phone_digits_idx ON customers (phone_digits);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);

-- ===== db/migrations/006_commission.sql =====
-- Slice 6 (commissions). For databases created before these objects were in schema.sql.
-- Safe to re-run. Dev databases only; review before running elsewhere.
CREATE TABLE IF NOT EXISTS commission_settings (
  id          smallint PRIMARY KEY CHECK (id = 1),
  cadence     text NOT NULL CHECK (cadence IN ('weekly','biweekly','semimonthly','monthly')),
  anchor_date date,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (cadence NOT IN ('weekly','biweekly') OR anchor_date IS NOT NULL)
);

ALTER TABLE commission_draws ADD COLUMN IF NOT EXISTS applied_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE commission_draws ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE commission_draws ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
ALTER TABLE commission_draws ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
DO $$ BEGIN
  ALTER TABLE commission_draws ADD CONSTRAINT commission_draws_amount_positive CHECK (amount_cents > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE commission_draws ADD CONSTRAINT commission_draws_applied_range CHECK (applied_cents >= 0 AND applied_cents <= amount_cents);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS commission_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimator_id uuid NOT NULL REFERENCES users(id),
  period_start date NOT NULL,
  period_end  date NOT NULL,
  gross_cents bigint NOT NULL,
  draws_applied_cents bigint NOT NULL,
  net_cents   bigint NOT NULL,
  paid_on     date NOT NULL,
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (estimator_id, period_end),
  CHECK (net_cents = gross_cents - draws_applied_cents)
);

CREATE TABLE IF NOT EXISTS commission_draw_applications (
  run_id      uuid NOT NULL REFERENCES commission_runs(id),
  draw_id     uuid NOT NULL REFERENCES commission_draws(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  PRIMARY KEY (run_id, draw_id)
);

ALTER TABLE commission_payouts ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE commission_payouts ALTER COLUMN payment_id DROP NOT NULL;
ALTER TABLE commission_payouts ALTER COLUMN rate_bps DROP NOT NULL;
ALTER TABLE commission_payouts ALTER COLUMN margin_bps DROP NOT NULL;
ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'earned';
ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS entry_date date;
UPDATE commission_payouts SET entry_date = COALESCE(paid_on, CURRENT_DATE) WHERE entry_date IS NULL;
ALTER TABLE commission_payouts ALTER COLUMN entry_date SET NOT NULL;
ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES commission_runs(id);
ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
DO $$ BEGIN ALTER TABLE commission_payouts ADD CONSTRAINT commission_kind_check CHECK (kind IN ('earned','reversal','adjustment'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE commission_payouts ADD CONSTRAINT commission_payment_required CHECK (kind = 'adjustment' OR payment_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE commission_payouts ADD CONSTRAINT commission_adjustment_note CHECK (kind <> 'adjustment' OR (note IS NOT NULL AND length(trim(note)) >= 3));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE commission_payouts ADD CONSTRAINT commission_earned_fields CHECK (kind <> 'earned' OR (rate_bps IS NOT NULL AND margin_bps IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE commission_payouts ADD CONSTRAINT commission_paid_consistent CHECK ((run_id IS NULL) = (paid_on IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS one_earned_per_payment   ON commission_payouts (payment_id) WHERE kind = 'earned';
CREATE UNIQUE INDEX IF NOT EXISTS one_reversal_per_payment ON commission_payouts (payment_id) WHERE kind = 'reversal';
CREATE INDEX IF NOT EXISTS commission_unpaid_idx ON commission_payouts (estimator_id, entry_date) WHERE run_id IS NULL;
-- ===== db/migrations/007_reports.sql =====
-- Slice 7 (reports). Replace the source_performance view so a win means a signed contract, not "has a contract amount".
-- Safe to re-run. Dev databases only; review before running elsewhere.
DROP VIEW IF EXISTS source_performance;
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
CREATE INDEX IF NOT EXISTS job_stage_history_stage_idx ON job_stage_history (to_stage, changed_at);
-- ===== db/migrations/008_scope_divisions.sql =====
-- Multi-trade jobs: an estimate (scope of work) per division. For databases created before scopes had a division.
-- Existing scopes are assigned to their job's first division. Safe to re-run. Dev databases only; review before running elsewhere.
ALTER TABLE scopes ADD COLUMN IF NOT EXISTS division division;
UPDATE scopes s SET division = (SELECT j.divisions[1] FROM jobs j WHERE j.id = s.job_id) WHERE s.division IS NULL;
ALTER TABLE scopes ALTER COLUMN division SET NOT NULL;
ALTER TABLE scopes DROP CONSTRAINT IF EXISTS scopes_job_id_tier_key;
DO $$ BEGIN
  ALTER TABLE scopes ADD CONSTRAINT scopes_job_division_tier_key UNIQUE (job_id, division, tier);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
DROP INDEX IF EXISTS one_selected_scope;
CREATE UNIQUE INDEX IF NOT EXISTS one_selected_scope_per_division ON scopes (job_id, division) WHERE selected;
-- ===== db/migrations/009_production.sql =====
-- Slice 8 (production scheduling). Safe to re-run. Dev databases only; review before running elsewhere.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS materials_ordered_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS materials_ordered_by uuid REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS po_reference text;

CREATE TABLE IF NOT EXISTS production_trades (
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  division      division NOT NULL,
  status        text NOT NULL DEFAULT 'not_scheduled' CHECK (status IN ('not_scheduled','proposed','scheduled','in_production','complete')),
  install_date  date,
  crew_leader_id uuid REFERENCES users(id),
  proposed_by   uuid REFERENCES users(id),
  confirmed_by  uuid REFERENCES users(id),
  started_at    timestamptz,
  completed_at  timestamptz,
  notes         text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, division),
  CHECK (status NOT IN ('scheduled','in_production','complete') OR (install_date IS NOT NULL AND crew_leader_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS production_trades_crew_idx ON production_trades (crew_leader_id, install_date);
CREATE INDEX IF NOT EXISTS production_trades_date_idx ON production_trades (install_date);

CREATE TABLE IF NOT EXISTS production_events (
  id          bigserial PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  division    division,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_events_job_idx ON production_events (job_id, created_at);
-- ===== db/migrations/010_companycam.sql =====
-- Slice 9 (CompanyCam link). Safe to re-run. Dev databases only; review before running elsewhere.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS companycam_project_id text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS companycam_project_url text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS companycam_status text NOT NULL DEFAULT 'none';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS companycam_link_method text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS companycam_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS companycam_next_attempt_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS companycam_error text;
DO $$ BEGIN
  ALTER TABLE jobs ADD CONSTRAINT jobs_companycam_status_check CHECK (companycam_status IN ('none','pending','linked','error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE jobs ADD CONSTRAINT jobs_companycam_method_check CHECK (companycam_link_method IN ('created','auto_match','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_companycam_project_idx ON jobs (companycam_project_id) WHERE companycam_project_id IS NOT NULL;
-- ===== db/migrations/011_closeout_invoicing.sql =====
-- Slice 10 (closeout punchlist and invoicing). Safe to re-run. Dev databases only; review before running elsewhere.

-- Punchlist: which trade an item belongs to (null = the whole job), its order, who added it.
ALTER TABLE punchlist_items ADD COLUMN IF NOT EXISTS division division;
ALTER TABLE punchlist_items ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
ALTER TABLE punchlist_items ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
ALTER TABLE punchlist_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS punchlist_items_job_idx ON punchlist_items (job_id, sort_order);

-- Invoices: a frozen snapshot of what was owed when it was issued. Never deleted; a mistake is voided.
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1001;
CREATE TABLE IF NOT EXISTS invoices (
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
CREATE INDEX IF NOT EXISTS invoices_job_idx ON invoices (job_id);
-- A job has at most one live invoice.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_live_idx ON invoices (job_id) WHERE status = 'issued';

-- ===== db/migrations/012_measurements.sql =====
-- Slice 11, part A (measurements and the Hover link). Safe to re-run. Dev databases only; review before running elsewhere.

-- Measurements for a job: from Hover or typed in. A re-measure adds a row; the newest row is the current one.
-- Areas are whole square feet; lengths are tenths of a foot (so 123.4 ft is 1234).
CREATE TABLE IF NOT EXISTS job_measurements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source             text NOT NULL CHECK (source IN ('hover','manual')),
  hover_job_id       text,
  hover_model_id     text,
  roof_area_sqft     integer NOT NULL CHECK (roof_area_sqft BETWEEN 0 AND 200000),
  facets             integer CHECK (facets IS NULL OR facets BETWEEN 0 AND 5000),
  pitches            jsonb NOT NULL DEFAULT '[]'::jsonb,
  ridges_hips_ft10   integer NOT NULL DEFAULT 0 CHECK (ridges_hips_ft10 BETWEEN 0 AND 5000000),
  valleys_ft10       integer NOT NULL DEFAULT 0 CHECK (valleys_ft10 BETWEEN 0 AND 5000000),
  rakes_ft10         integer NOT NULL DEFAULT 0 CHECK (rakes_ft10 BETWEEN 0 AND 5000000),
  eaves_ft10         integer NOT NULL DEFAULT 0 CHECK (eaves_ft10 BETWEEN 0 AND 5000000),
  flashing_ft10      integer NOT NULL DEFAULT 0 CHECK (flashing_ft10 BETWEEN 0 AND 5000000),
  step_flashing_ft10 integer NOT NULL DEFAULT 0 CHECK (step_flashing_ft10 BETWEEN 0 AND 5000000),
  siding_area_sqft   integer CHECK (siding_area_sqft IS NULL OR siding_area_sqft BETWEEN 0 AND 500000),
  raw                jsonb,
  note               text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_measurements_job_idx ON job_measurements (job_id, created_at DESC);

-- OAuth tokens for outside systems (Hover). Tokens are stored ENCRYPTED (AES-256-GCM, key in the server environment); the
-- plain text never touches the database. One row per system.
CREATE TABLE IF NOT EXISTS integration_credentials (
  system             text PRIMARY KEY,
  access_token_enc   text NOT NULL,
  refresh_token_enc  text NOT NULL,
  expires_at         timestamptz NOT NULL,
  owner_id           text,
  status             text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','needs_reconnect')),
  connected_by       uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ===== db/migrations/013_roofing_assemblies.sql =====
-- Slice 11, part B (roofing scope built from measurements). Safe to re-run. Dev databases only; review before running elsewhere.

-- A labor or "other" line says what it is measured in (sq, lf, ea...), so a work order can read "42 sq".
-- Material lines take their unit from the catalog product, so this stays empty for them.
ALTER TABLE scope_items ADD COLUMN IF NOT EXISTS unit text;

-- Roofing assembly settings: for each package tier, which catalog product fills each material role (with how much one unit
-- covers) and which labor lines go on the scope (with a cost rate). Edited by an admin. Sample rows for a dev database
-- live in db/seed_assemblies.sql; production starts empty and an admin fills it in.
CREATE TABLE IF NOT EXISTS roofing_assembly_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier          text NOT NULL CHECK (tier IN ('good','better','best')),
  role          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('material','labor')),
  product_id    uuid REFERENCES products(id),
  description   text,
  unit          text,
  coverage      numeric(10,2) CHECK (coverage IS NULL OR coverage > 0),
  unit_cost_cents bigint CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  sort_order    integer NOT NULL DEFAULT 0,
  enabled       boolean NOT NULL DEFAULT true,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tier, role)
);

-- ===== db/migrations/014_work_orders.sql =====
-- Slice 11, part C (work orders). Safe to re-run. Dev databases only; review before running elsewhere.
-- A work order is what a crew works from: the labor tasks of the signed scope, with quantities and units. There is deliberately
-- NO price, cost, rate or margin column on either table, so money can never reach a crew's copy.

-- One work order per trade per job. It starts as a draft made from the signed scope; the estimator reviews it, adds notes
-- and issues it. Issuing freezes the task list.
CREATE TABLE IF NOT EXISTS work_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  division    division NOT NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued')),
  notes       text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  issued_by   uuid REFERENCES users(id),
  issued_at   timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, division),
  CHECK ((status = 'issued') = (issued_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS work_order_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id  uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  sort_order     integer NOT NULL DEFAULT 0,
  source_item_id uuid REFERENCES scope_items(id) ON DELETE SET NULL,   -- the scope line it came from; null = added by hand
  description    text NOT NULL,
  quantity       numeric(12,2) NOT NULL CHECK (quantity > 0),
  unit           text NOT NULL DEFAULT 'ea',
  note           text
);
CREATE INDEX IF NOT EXISTS work_order_lines_order_idx ON work_order_lines (work_order_id, sort_order);

-- ===== first admin =====
INSERT INTO users (full_name, email, role) VALUES ('AL Kharitonov', 'al@aaqualityroofing.com', 'admin');
COMMIT;
