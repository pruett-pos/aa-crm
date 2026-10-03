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
