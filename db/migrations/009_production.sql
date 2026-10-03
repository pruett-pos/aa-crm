-- Slice 8 (production scheduling). Safe to re-run. Dev databases only; review before running elsewhere.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS materials_ordered_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS materials_ordered_by uuid REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS po_reference text;

CREATE TABLE IF NOT EXISTS production_trades (
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  division      division NOT NULL,
  status        text NOT NULL DEFAULT 'not_scheduled' CHECK (status IN ('not_scheduled','proposed','scheduled','in_production','complete')),
  install_date  date,
  crew_leader_id uuid REFERENCES users(id),
  proposed_by   uuid REFERENCES users(id),
  confirmed_by  uuid REFERENCES users(id),
  started_at    timestamptz,
  completed_at  timestamptz,
  notes         text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, division),
  CHECK (status NOT IN ('scheduled','in_production','complete') OR (install_date IS NOT NULL AND crew_leader_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS production_trades_crew_idx ON production_trades (crew_leader_id, install_date);
CREATE INDEX IF NOT EXISTS production_trades_date_idx ON production_trades (install_date);

CREATE TABLE IF NOT EXISTS production_events (
  id          bigserial PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  division    division,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_events_job_idx ON production_events (job_id, created_at);