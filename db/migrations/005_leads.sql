-- Slice 5 (lead intake and routing). For databases created before these columns were in schema.sql.
-- Safe to re-run. Dev databases only; review before running elsewhere.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_digits text;
UPDATE customers SET phone_digits = right(regexp_replace(phone, '\D', '', 'g'), 10)
  WHERE phone IS NOT NULL AND phone_digits IS NULL AND length(regexp_replace(phone, '\D', '', 'g')) >= 10;
CREATE INDEX IF NOT EXISTS customers_phone_digits_idx ON customers (phone_digits);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
