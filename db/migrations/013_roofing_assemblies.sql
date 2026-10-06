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
