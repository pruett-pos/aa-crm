-- Slice 11, part C (work orders). Safe to re-run. Dev databases only; review before running elsewhere.
-- A work order is what a crew works from: the labor tasks of the signed scope, with quantities and units. There is deliberately
-- NO price, cost, rate or margin column on either table, so money can never reach a crew's copy.

-- One work order per trade per job. It starts as a draft made from the signed scope; the estimator reviews it, adds notes
-- and issues it. Issuing freezes the task list.
CREATE TABLE IF NOT EXISTS work_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  division    division NOT NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued')),
  notes       text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  issued_by   uuid REFERENCES users(id),
  issued_at   timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, division),
  CHECK ((status = 'issued') = (issued_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS work_order_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id  uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  sort_order     integer NOT NULL DEFAULT 0,
  source_item_id uuid REFERENCES scope_items(id) ON DELETE SET NULL,   -- the scope line it came from; null = added by hand
  description    text NOT NULL,
  quantity       numeric(12,2) NOT NULL CHECK (quantity > 0),
  unit           text NOT NULL DEFAULT 'ea',
  note           text
);
CREATE INDEX IF NOT EXISTS work_order_lines_order_idx ON work_order_lines (work_order_id, sort_order);
