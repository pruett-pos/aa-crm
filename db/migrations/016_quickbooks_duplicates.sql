-- QuickBooks customer matching: a customer that matched an existing QuickBooks customer on NAME ONLY is created as a new
-- QuickBooks customer and listed here as a possible duplicate, so an admin can link it to the existing one. Safe to re-run.
CREATE TABLE IF NOT EXISTS qbo_customer_flags (
  customer_id    uuid PRIMARY KEY,
  customer_name  text NOT NULL,
  created_qbo_id text NOT NULL,
  candidates     jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','linked','dismissed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);
CREATE INDEX IF NOT EXISTS qbo_customer_flags_open_idx ON qbo_customer_flags (created_at) WHERE status = 'open';
