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
