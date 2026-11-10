-- Pruett nightly price sync. Applied by the migration runner on deploy (scripts/migrate.ts). Safe to re-run.
-- Products now remember where they came from, what A&A pays (Pruett's own price at our level), and whether they are active.
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_cents bigint CHECK (cost_cents IS NULL OR cost_cents >= 0);  -- Pruett price_cents; null = hand-entered, cost is worked out from retail in rules.ts
ALTER TABLE products ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE products ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE products ADD COLUMN IF NOT EXISTS description2 text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_sku text;
DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT products_source_check CHECK (source IN ('manual','pruett'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row per price run. This is also the sync log.
CREATE TABLE IF NOT EXISTS pruett_sync_runs (
  id                bigserial PRIMARY KEY,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  trigger           text NOT NULL CHECK (trigger IN ('cron','manual')),
  triggered_by      uuid REFERENCES users(id),
  status            text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','warning','error')),
  items_seen        integer NOT NULL DEFAULT 0,
  items_new         integer NOT NULL DEFAULT 0,
  items_changed     integer NOT NULL DEFAULT 0,
  items_deactivated integer NOT NULL DEFAULT 0,
  warning           text,
  error             text
);
CREATE INDEX IF NOT EXISTS pruett_sync_runs_started_idx ON pruett_sync_runs (started_at DESC);

-- Every price change: old -> new, and when. Integer cents.
CREATE TABLE IF NOT EXISTS product_price_history (
  id               bigserial PRIMARY KEY,
  product_id       uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  changed_at       timestamptz NOT NULL DEFAULT now(),
  old_cost_cents   bigint,
  new_cost_cents   bigint,
  old_retail_cents bigint NOT NULL,
  new_retail_cents bigint NOT NULL,
  sync_run_id      bigint REFERENCES pruett_sync_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS product_price_history_product_idx ON product_price_history (product_id, changed_at DESC);
