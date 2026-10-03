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