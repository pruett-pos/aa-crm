-- Dev seed: two crew leaders (fake). Run after seed.sql. Idempotent.
INSERT INTO users (id, full_name, email, role, market, own_truck) VALUES
 ('00000000-0000-0000-0000-000000000008','Crew One','crew1@example.com','crew_leader','west_plains',false),
 ('00000000-0000-0000-0000-000000000009','Crew Two','crew2@example.com','crew_leader','west_plains',false)
ON CONFLICT (id) DO NOTHING;
