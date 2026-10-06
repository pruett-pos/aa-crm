-- Slice 11, part A (measurements and the Hover link). Safe to re-run. Dev databases only; review before running elsewhere.

-- Measurements for a job: from Hover or typed in. A re-measure adds a row; the newest row is the current one.
-- Areas are whole square feet; lengths are tenths of a foot (so 123.4 ft is 1234).
CREATE TABLE IF NOT EXISTS job_measurements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source             text NOT NULL CHECK (source IN ('hover','manual')),
  hover_job_id       text,
  hover_model_id     text,
  roof_area_sqft     integer NOT NULL CHECK (roof_area_sqft BETWEEN 0 AND 200000),
  facets             integer CHECK (facets IS NULL OR facets BETWEEN 0 AND 5000),
  pitches            jsonb NOT NULL DEFAULT '[]'::jsonb,
  ridges_hips_ft10   integer NOT NULL DEFAULT 0 CHECK (ridges_hips_ft10 BETWEEN 0 AND 5000000),
  valleys_ft10       integer NOT NULL DEFAULT 0 CHECK (valleys_ft10 BETWEEN 0 AND 5000000),
  rakes_ft10         integer NOT NULL DEFAULT 0 CHECK (rakes_ft10 BETWEEN 0 AND 5000000),
  eaves_ft10         integer NOT NULL DEFAULT 0 CHECK (eaves_ft10 BETWEEN 0 AND 5000000),
  flashing_ft10      integer NOT NULL DEFAULT 0 CHECK (flashing_ft10 BETWEEN 0 AND 5000000),
  step_flashing_ft10 integer NOT NULL DEFAULT 0 CHECK (step_flashing_ft10 BETWEEN 0 AND 5000000),
  siding_area_sqft   integer CHECK (siding_area_sqft IS NULL OR siding_area_sqft BETWEEN 0 AND 500000),
  raw                jsonb,
  note               text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_measurements_job_idx ON job_measurements (job_id, created_at DESC);

-- OAuth tokens for outside systems (Hover). Tokens are stored ENCRYPTED (AES-256-GCM, key in the server environment); the
-- plain text never touches the database. One row per system.
CREATE TABLE IF NOT EXISTS integration_credentials (
  system             text PRIMARY KEY,
  access_token_enc   text NOT NULL,
  refresh_token_enc  text NOT NULL,
  expires_at         timestamptz NOT NULL,
  owner_id           text,
  status             text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','needs_reconnect')),
  connected_by       uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
