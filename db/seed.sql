-- Dev seed data (fake people). Run after schema.sql.
INSERT INTO users (id, full_name, email, role, market, own_truck) VALUES
 ('00000000-0000-0000-0000-000000000001','Admin User','admin@example.com','admin',NULL,false),
 ('00000000-0000-0000-0000-000000000002','Estimator One','est1@example.com','estimator','west_plains',true),
 ('00000000-0000-0000-0000-000000000003','Estimator Two','est2@example.com','estimator','springfield',false),
 ('00000000-0000-0000-0000-000000000004','Siding PM','pm.siding@example.com','production_manager','west_plains',false),
 ('00000000-0000-0000-0000-000000000005','Roofing PM','pm.roofing@example.com','production_manager','west_plains',false),
 ('00000000-0000-0000-0000-000000000006','CSR One','csr@example.com','csr','west_plains',false);

INSERT INTO division_managers VALUES
 ('siding','west_plains','00000000-0000-0000-0000-000000000004'),
 ('gutters','west_plains','00000000-0000-0000-0000-000000000004'),
 ('windows_doors','west_plains','00000000-0000-0000-0000-000000000004'),
 ('roofing','west_plains','00000000-0000-0000-0000-000000000005');

INSERT INTO customers (id, first_name, last_name, phone, last_estimator_id) VALUES
 ('10000000-0000-0000-0000-000000000001','Dana','Miller','417-555-0101','00000000-0000-0000-0000-000000000002'),
 ('10000000-0000-0000-0000-000000000002','Sam','Ortiz','417-555-0102',NULL);

INSERT INTO properties (id, customer_id, street, city, zip, market) VALUES
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','100 Example Rd','West Plains','65775','west_plains'),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','200 Sample Ave','Springfield','65806','springfield');

INSERT INTO marketing_spend VALUES ('phone', date_trunc('month', now())::date, 200000),
                                   ('demandiq', date_trunc('month', now())::date, 150000);

INSERT INTO jobs (property_id, job_type, divisions, stage, source, estimator_id, contract_cents, cost_cents) VALUES
 ('20000000-0000-0000-0000-000000000001','insurance','{roofing,gutters}','claim_approved','phone','00000000-0000-0000-0000-000000000002',NULL,NULL),
 ('20000000-0000-0000-0000-000000000002','retail','{siding}','contract_signed','demandiq','00000000-0000-0000-0000-000000000003',2400000,1500000),
 ('20000000-0000-0000-0000-000000000002','retail','{windows_doors}','new_lead','demandiq',NULL,NULL,NULL);
