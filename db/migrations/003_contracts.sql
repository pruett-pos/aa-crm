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
