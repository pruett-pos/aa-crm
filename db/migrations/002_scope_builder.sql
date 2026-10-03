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
