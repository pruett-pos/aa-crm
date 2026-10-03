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