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
  qbo_customer_id   text,
  leap_id       text,                              -- for migration traceability
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_phone_idx ON customers (phone);

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
  estimator_id  uuid REFERENCES users(id),
  production_manager_id uuid REFERENCES users(id),
  crew_leader_id uuid REFERENCES users(id),
  appointment_at timestamptz,
  install_date   date,
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
  tier        package_tier NOT NULL,
  title       text NOT NULL,           -- e.g. "Malarkey Highlander"
  sale_cents  bigint NOT NULL DEFAULT 0,
  selected    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, tier)
);
CREATE UNIQUE INDEX one_selected_scope ON scopes (job_id) WHERE selected;

CREATE TABLE scope_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id    uuid NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
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
  esign_envelope_id text,
  signed_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method      payment_method NOT NULL,
  is_deposit  boolean NOT NULL DEFAULT false,
  is_depreciation boolean NOT NULL DEFAULT false,
  collected_by uuid REFERENCES users(id),
  check_photo_url text,
  qbo_payment_id text,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Commission ----------------------------------------------------------------
CREATE TABLE commission_draws (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimator_id uuid NOT NULL REFERENCES users(id),
  amount_cents bigint NOT NULL,
  paid_on     date NOT NULL
);

CREATE TABLE commission_payouts (       -- computed from payments via rules.ts
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimator_id uuid NOT NULL REFERENCES users(id),
  job_id      uuid NOT NULL REFERENCES jobs(id),
  payment_id  uuid NOT NULL REFERENCES payments(id),
  rate_bps    integer NOT NULL,
  margin_bps  integer NOT NULL,
  amount_cents bigint NOT NULL,
  paid_on     date
);

-- Closeout --------------------------------------------------------------------
CREATE TABLE punchlist_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  label_en    text NOT NULL,
  label_ru    text,
  done        boolean NOT NULL DEFAULT false,
  done_by     uuid REFERENCES users(id),
  done_at     timestamptz
);

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
CREATE VIEW source_performance AS
SELECT j.source,
       date_trunc('month', j.created_at)::date AS month,
       count(*)                                         AS leads,
       count(*) FILTER (WHERE j.contract_cents IS NOT NULL) AS wins,
       round(100.0 * count(*) FILTER (WHERE j.contract_cents IS NOT NULL) / nullif(count(*),0), 1) AS close_rate_pct,
       max(ms.spend_cents) / nullif(count(*),0)         AS cost_per_lead_cents,
       max(ms.spend_cents) / nullif(count(*) FILTER (WHERE j.contract_cents IS NOT NULL),0) AS cost_per_win_cents
FROM jobs j
LEFT JOIN marketing_spend ms
  ON ms.source = j.source AND ms.month = date_trunc('month', j.created_at)::date
GROUP BY 1, 2;
