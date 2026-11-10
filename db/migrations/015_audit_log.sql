-- Audit log: who changed users and settings, and what changed. Append-only: the trigger below refuses UPDATE and DELETE.
CREATE TABLE IF NOT EXISTS audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,             -- the signed-in user; no foreign key so the row never blocks or changes with the user
  actor_email text,             -- who it was at the time
  action      text NOT NULL,    -- e.g. user.created, user.role_changed, settings.product_updated
  entity_type text NOT NULL,    -- user, product, commission_schedule, marketing_spend, roofing_assembly, hover
  entity_id   text,
  summary     text NOT NULL,    -- one plain-English line for the screen
  details     jsonb             -- before/after values; never secrets or tokens
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity_type, entity_id);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
