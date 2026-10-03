import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, phoneSearchDigits } from "../src/lib/leads/phone.ts";
import { pickPm, routeLead, type PmRow } from "../src/lib/leads/routing.ts";

test("phone: formats collapse to 10 digits; junk is rejected", () => {
  for (const ok of ["417-555-0101", "(417) 555-0101", "417.555.0101", "+1 417 555 0101", "14175550101", " 4175550101 "]) {
    assert.equal(normalizePhone(ok), "4175550101", ok);
  }
  for (const bad of ["", "555-0101", "123456789", "0175550101", "1175550101", "41755501012", "abc", "417-555-010x1"]) {
    assert.equal(normalizePhone(bad), null, bad);
  }
});

test("phone search: only 7+ digit queries are phone searches", () => {
  assert.equal(phoneSearchDigits("555-0101"), "5550101");
  assert.equal(phoneSearchDigits("(417) 555-0101"), "4175550101");
  assert.equal(phoneSearchDigits("1-417-555-0101"), "4175550101");
  assert.equal(phoneSearchDigits("Dana"), null);
  assert.equal(phoneSearchDigits("100 Example"), null);
  assert.equal(phoneSearchDigits("12345"), null);
});

const pms: PmRow[] = [
  { division: "siding", market: "west_plains", userId: "pm-siding" },
  { division: "roofing", market: "west_plains", userId: "pm-roofing-wp" },
  { division: "roofing", market: "springfield", userId: "pm-roofing-sg" },
];

test("pm: prefers the property's market, falls back to any market, none if no PM", () => {
  assert.equal(pickPm(pms, "roofing", "springfield"), "pm-roofing-sg");
  assert.equal(pickPm(pms, "roofing", "west_plains"), "pm-roofing-wp");
  assert.equal(pickPm(pms, "roofing", "nw_arkansas"), "pm-roofing-wp"); // no market limit
  assert.equal(pickPm(pms, "siding", "springfield"), "pm-siding");
  assert.equal(pickPm(pms, "spray_foam", "west_plains"), undefined);
});

test("routing: existing customer goes to the estimator who handled them last", () => {
  const r = routeLead({ lastEstimatorId: "est1", divisions: ["siding"], market: "west_plains", pmRows: pms });
  assert.deepEqual(r, { estimatorId: "est1", productionManagerId: null, via: "last_estimator", needsAssignment: false });
});

test("routing: no estimator on file goes to the division's PM, by market", () => {
  const r = routeLead({ lastEstimatorId: null, divisions: ["roofing", "gutters"], market: "springfield", pmRows: pms });
  assert.deepEqual(r, { estimatorId: null, productionManagerId: "pm-roofing-sg", via: "division_pm", needsAssignment: false });
});

test("routing: the first selected division decides", () => {
  const r = routeLead({ lastEstimatorId: null, divisions: ["siding", "roofing"], market: "west_plains", pmRows: pms });
  assert.equal(r.productionManagerId, "pm-siding");
});

test("routing: a division with no PM is flagged, not an error", () => {
  const r = routeLead({ lastEstimatorId: null, divisions: ["spray_foam"], market: "west_plains", pmRows: pms });
  assert.deepEqual(r, { estimatorId: null, productionManagerId: null, via: "none", needsAssignment: true });
  assert.equal(routeLead({ lastEstimatorId: null, divisions: [], market: "west_plains", pmRows: pms }).needsAssignment, true);
});

test("routing: last estimator still wins even when the division has no PM", () => {
  const r = routeLead({ lastEstimatorId: "est2", divisions: ["spray_foam"], market: "west_plains", pmRows: pms });
  assert.equal(r.estimatorId, "est2");
  assert.equal(r.needsAssignment, false);
});

test("routing: a CSR override beats everything", () => {
  const r = routeLead({ lastEstimatorId: "est1", divisions: ["siding"], market: "west_plains", pmRows: pms, overrideEstimatorId: "est2" });
  assert.deepEqual(r, { estimatorId: "est2", productionManagerId: null, via: "override", needsAssignment: false });
});
