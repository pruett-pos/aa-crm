-- Sample catalog (fake SKUs and prices) standing in for the nightly Pruett POS sync.
-- retail_cents is Pruett retail; the app prices materials at Builder plan (retail - 12%).
-- Idempotent: safe to run more than once, after schema.sql.
INSERT INTO products (pruett_sku, name, unit, retail_cents, special_order) VALUES
 ('SAMPLE-SHG-HL',   'Architectural shingles - Highlander',      'sq',     13_500, false),
 ('SAMPLE-SHG-VS',   'Architectural shingles - Vista',           'sq',     11_800, false),
 ('SAMPLE-SHG-DES',  'Designer shingles',                        'sq',     17_900, true),
 ('SAMPLE-UND-SYN',  'Synthetic underlayment',                   'roll',   11_500, false),
 ('SAMPLE-ICE',      'Ice and water shield',                     'roll',   9_800,  false),
 ('SAMPLE-STARTER',  'Starter strip',                            'bundle', 4_800,  false),
 ('SAMPLE-RIDGE',    'Ridge cap shingles',                       'bundle', 5_900,  false),
 ('SAMPLE-DRIP',     'Drip edge 10 ft',                          'ea',     1_150,  false),
 ('SAMPLE-VENT',     'Ridge vent 4 ft',                          'ea',     1_950,  false),
 ('SAMPLE-PIPE',     'Pipe boot',                                'ea',     1_400,  false),
 ('SAMPLE-NAILS',    'Roofing nails 5 lb box',                   'ea',     2_600,  false),
 ('SAMPLE-SID-VNL',  'Vinyl siding',                             'sq',     9_400,  false),
 ('SAMPLE-SID-FC',   'Fiber cement lap siding',                  'sq',     21_500, true),
 ('SAMPLE-GUT-5K',   'Seamless gutter 5 in',                     'lf',     520,    false),
 ('SAMPLE-DOWN',     'Downspout 10 ft',                          'ea',     1_350,  false)
ON CONFLICT (pruett_sku) DO NOTHING;
