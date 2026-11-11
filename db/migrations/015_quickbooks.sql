-- QuickBooks Online push (CRM -> QBO). Safe to re-run. Dev databases only; production gets it through the migration runner.
-- Tokens live in integration_credentials (system = 'quickbooks', owner_id = the QBO realmId), encrypted like Hover's.

-- Small key/value settings: realm_id, company_name, environment, connected_at, sync_from.
CREATE TABLE IF NOT EXISTS qbo_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- CRM lead source -> QBO class name. No row = the class is named after the source.
CREATE TABLE IF NOT EXISTS qbo_class_map (
  lead_source text PRIMARY KEY,
  class_name  text NOT NULL CHECK (length(class_name) BETWEEN 1 AND 100)
);

-- CRM division -> QBO product/service (item) name. No row = the division's plain name (Roofing, Siding, ...).
CREATE TABLE IF NOT EXISTS qbo_item_map (
  division  text PRIMARY KEY,
  item_name text NOT NULL CHECK (length(item_name) BETWEEN 1 AND 100)
);

-- Ids QuickBooks gave things we looked up or created (classes, items, payment methods), so we ask once.
CREATE TABLE IF NOT EXISTS qbo_refs (
  kind   text NOT NULL,
  key    text NOT NULL,
  qbo_id text NOT NULL,
  PRIMARY KEY (kind, key)
);

-- Which QBO record each CRM record became (customer, invoice, payment). parent_qbo_id = the QBO invoice a payment was applied to.
CREATE TABLE IF NOT EXISTS qbo_links (
  entity_type   text NOT NULL CHECK (entity_type IN ('customer','invoice','payment')),
  entity_id     uuid NOT NULL,
  qbo_id        text NOT NULL,
  parent_qbo_id text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS qbo_links_parent_idx ON qbo_links (parent_qbo_id) WHERE parent_qbo_id IS NOT NULL;

-- The outbox: one row per push. request_id is sent to QuickBooks as RequestId so a retry can never create a second copy.
CREATE TABLE IF NOT EXISTS qbo_sync_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('invoice','payment','void_invoice','void_payment')),
  entity_id        uuid NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','waiting','running','done','failed','cancelled')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_at        timestamptz,
  last_error       text,
  qbo_id           text,
  request_id       text NOT NULL,
  payload          jsonb,
  crm_total_cents  bigint,
  qbo_total_cents  bigint,
  mismatch         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, entity_id)
);
CREATE INDEX IF NOT EXISTS qbo_sync_jobs_due_idx ON qbo_sync_jobs (next_attempt_at) WHERE status IN ('pending','waiting');
CREATE INDEX IF NOT EXISTS qbo_sync_jobs_status_idx ON qbo_sync_jobs (status);
