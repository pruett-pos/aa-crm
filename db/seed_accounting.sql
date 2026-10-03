-- Dev seed: one Accounting user (fake). Run after seed.sql. Idempotent.
INSERT INTO users (id, full_name, email, role, market, own_truck) VALUES
 ('00000000-0000-0000-0000-000000000007','Accounting One','acct@example.com','accounting',NULL,false)
ON CONFLICT (id) DO NOTHING;
