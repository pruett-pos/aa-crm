-- SAMPLE roofing assembly settings for a DEV database only (sample products, sample coverage, SAMPLE labor rates).
-- Production starts with no rows: an admin fills in A&A's real products, coverage and labor rates under Settings, Roofing assemblies.
-- Run after schema.sql and seed_products.sql. Idempotent: it never overwrites a row that already exists.
INSERT INTO roofing_assembly_lines (tier, role, kind, product_id, description, unit, coverage, unit_cost_cents, sort_order)
SELECT t.tier, m.role, 'material',
       (SELECT id FROM products WHERE pruett_sku = CASE WHEN m.role = 'shingles' THEN t.shingle ELSE m.sku END),
       NULL, NULL, m.coverage, NULL, m.sort
FROM (VALUES ('good','SAMPLE-SHG-VS'), ('better','SAMPLE-SHG-HL'), ('best','SAMPLE-SHG-DES')) AS t(tier, shingle)
CROSS JOIN (VALUES
  ('shingles',     NULL,              NULL::numeric, 10),
  ('starter',      'SAMPLE-STARTER',  105,           20),
  ('ridge_cap',    'SAMPLE-RIDGE',    33,            30),
  ('underlayment', 'SAMPLE-UND-SYN',  10,            40),
  ('ice_water',    'SAMPLE-ICE',      200,           50),
  ('drip_edge',    'SAMPLE-DRIP',     10,            60),
  ('nails',        'SAMPLE-NAILS',    1.5,           70)
) AS m(role, sku, coverage, sort)
ON CONFLICT (tier, role) DO NOTHING;

INSERT INTO roofing_assembly_lines (tier, role, kind, description, unit, unit_cost_cents, sort_order)
SELECT t.tier, l.role, 'labor', l.descr, l.unit, l.rate, l.sort
FROM (VALUES ('good'), ('better'), ('best')) AS t(tier)
CROSS JOIN (VALUES
  ('tear_off',         'Tear off existing roof (sample rate)',   'sq', 1800, 100),
  ('install_shingles', 'Install shingles (sample rate)',         'sq', 2600, 110),
  ('ridge_cap_labor',  'Install ridge and hip cap (sample rate)', 'lf', 150,  120),
  ('valley_labor',     'Install valleys (sample rate)',          'lf', 120,  130),
  ('steep_labor',      'Steep roof labor (sample rate)',         'sq', 500,  140)
) AS l(role, descr, unit, rate, sort)
ON CONFLICT (tier, role) DO NOTHING;
