-- Shared rate limiter state, so sign-in throttling survives deploys and works across instances.
-- The key is a SHA-256 hash (never an email or IP in clear). Expired rows are cleaned up opportunistically.
CREATE TABLE IF NOT EXISTS rate_limits (
  key      text PRIMARY KEY,
  hits     integer NOT NULL,
  reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits (reset_at);
