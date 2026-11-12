-- Aerial roof estimate (Google Solar API), fetched when a Free Inspection is booked. Safe to re-run.

-- One row per property. It is a first look for the estimator ("verify on site"), kept apart from job_measurements on
-- purpose: contracts and material orders are built only from Hover or typed-in measurements, never from this table.
-- Areas are whole square feet. squares_x10 is roofing squares in tenths (243 = 24.3 squares). Percentages are basis points.
CREATE TABLE IF NOT EXISTS property_aerial_estimates (
  property_id     uuid PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('pending','ok','no_data','error')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  error           text,                                  -- a short fixed reason, never Google's own text
  lat             double precision,
  lng             double precision,
  raw_area_sqft   integer CHECK (raw_area_sqft IS NULL OR raw_area_sqft BETWEEN 0 AND 200000),   -- as Google measured it
  correction_bps  integer CHECK (correction_bps IS NULL OR correction_bps BETWEEN 5000 AND 15000),
  roof_area_sqft  integer CHECK (roof_area_sqft IS NULL OR roof_area_sqft BETWEEN 0 AND 300000),  -- raw area x correction
  squares_x10     integer CHECK (squares_x10 IS NULL OR squares_x10 BETWEEN 0 AND 30000),
  main_pitch      text,
  segment_count   integer CHECK (segment_count IS NULL OR segment_count BETWEEN 0 AND 100000),
  segments        jsonb NOT NULL DEFAULT '[]'::jsonb,    -- [{ areaSqft, pitch, pitchDegrees, azimuthDegrees }]
  imagery_quality text,
  imagery_date    date,
  confidence      text CHECK (confidence IS NULL OR confidence IN ('high','medium','low')),
  raw             jsonb,                                 -- Google's response, kept for the record, never loaded for screens
  image_data      bytea,                                 -- satellite picture (Maps Static API, zoom 20, 640x640)
  image_mime      text,
  fetched_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Admin settings, a single row. The feature starts OFF. Lengths are tenths of a foot per roofing square.
CREATE TABLE IF NOT EXISTS aerial_settings (
  id                       smallint PRIMARY KEY CHECK (id = 1),
  enabled                  boolean NOT NULL DEFAULT false,
  waste_bps                integer NOT NULL DEFAULT 1000  CHECK (waste_bps BETWEEN 0 AND 3000),
  correction_bps           integer NOT NULL DEFAULT 10000 CHECK (correction_bps BETWEEN 5000 AND 15000),
  eaves_ft10_per_sq        integer NOT NULL DEFAULT 50 CHECK (eaves_ft10_per_sq BETWEEN 0 AND 500),
  rakes_ft10_per_sq        integer NOT NULL DEFAULT 40 CHECK (rakes_ft10_per_sq BETWEEN 0 AND 500),
  ridges_hips_ft10_per_sq  integer NOT NULL DEFAULT 25 CHECK (ridges_hips_ft10_per_sq BETWEEN 0 AND 500),
  valleys_ft10_per_sq      integer NOT NULL DEFAULT 10 CHECK (valleys_ft10_per_sq BETWEEN 0 AND 500),
  updated_by               uuid REFERENCES users(id),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
