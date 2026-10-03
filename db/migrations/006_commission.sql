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