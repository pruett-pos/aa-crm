import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LeadError, canTakeLeads, confirmLead, createLead, createWebsiteLead, parseSpendCents, searchCustomers,
  setMarketingSpend, type CreateLeadInput,
} from "../src/lib/leads/logic.ts";
import { MemoryLeadStore } from "../src/lib/leads/memory-store.ts";

function setup() {
  const s = new MemoryLeadStore();
  s.pms = [
    { division: "siding", market: "west_plains", userId: "pm-siding" },
    { division: "roofing", market: "west_plains", userId: "pm-roofing" },
  ];
  s.estimators = [{ id: "est1", fullName: "Estimator One" }, { id: "est2", fullName: "Estimator Two" }];
  s.customers.push({ id: "c-dana", firstName: "Dana", lastName: "Miller", phone: "417-555-0101", email: null, lastEstimatorId: "est1", phoneDigits: "4175550101" });
  s.properties.push({ id: "p-dana", customerId: "c-dana", street: "100 Example Rd", city: "West Plains", state: "MO", zip: "65775", market: "west_plains" });
  return s;
}
const newCaller = { firstName: "Pat", lastName: "Lee", phone: "(417) 555-0199" };
const addr = { street: "5 Hilltop Dr", city: "Willow Springs", zip: "65793" };
const base = (over: Partial<CreateLeadInput> = {}): CreateLeadInput => ({
  actorId: "csr1", customer: newCaller, property: addr, market: "west_plains", jobType: "retail",
  divisions: ["siding"], source: "phone", ...over,
});
const code = (p: Promise<unknown>) => p.then(() => "no error", (e: LeadError) => e.code);
const now = () => new Date("2026-10-05T12:00:00Z");

test("create: new caller routes to the division's PM and is not assigned an estimator", async () => {
  const s = setup();
  const r = await createLead(s, base(), now);
  assert.equal(r.route.via, "division_pm");
  assert.equal(s.jobs[0].productionManagerId, "pm-siding");
  assert.equal(s.jobs[0].estimatorId, null);
  assert.equal(s.jobs[0].stage, "new_lead");
  assert.equal(s.jobs[0].needsReview, false);
  assert.deepEqual(s.history.map((h) => [h.from, h.to, h.by]), [[null, "new_lead", "csr1"]]);
  assert.equal(s.customers.find((c) => c.firstName === "Pat")?.lastEstimatorId, null);
});

test("create: existing customer found by phone routes to the estimator who handled them last", async () => {
  const s = setup();
  const r = await createLead(s, base({ customer: { firstName: "Dana", lastName: "Miller", phone: "+1 417 555 0101" }, property: { existingId: "p-dana" } }), now);
  assert.equal(r.reusedCustomer, true);
  assert.equal(s.customers.length, 1); // not duplicated
  assert.equal(r.route.via, "last_estimator");
  assert.equal(s.jobs[0].estimatorId, "est1");
  assert.equal(s.jobs[0].productionManagerId, null);
});

test("create: reuses the same address instead of adding a duplicate property", async () => {
  const s = setup();
  await createLead(s, base({ customer: { existingId: "c-dana" }, property: { street: "100 example rd", city: "West Plains", zip: "65775" } }), now);
  assert.equal(s.properties.length, 1);
});

test("create: a property that belongs to someone else is refused", async () => {
  const s = setup();
  s.customers.push({ id: "c-x", firstName: "X", lastName: "Y", phone: null, email: "x@y.com", lastEstimatorId: null, phoneDigits: null });
  assert.equal(await code(createLead(s, base({ customer: { existingId: "c-x" }, property: { existingId: "p-dana" } }), now)), "not_found");
  assert.equal(s.jobs.length, 0);
});

test("create: a division with no PM is created unassigned and flagged, not rejected", async () => {
  const s = setup();
  const r = await createLead(s, base({ divisions: ["spray_foam"] }), now);
  assert.equal(r.route.needsAssignment, true);
  assert.equal(s.jobs.length, 1);
});

test("create: an appointment sets the stage; a CSR can override the estimator; remembered for next time", async () => {
  const s = setup();
  const r = await createLead(s, base({ appointmentAt: new Date("2026-10-07T15:00:00Z"), overrideEstimatorId: "est2" }), now);
  assert.equal(s.jobs[0].stage, "appointment_set");
  assert.equal(r.route.via, "override");
  assert.equal(s.customers.find((c) => c.firstName === "Pat")?.lastEstimatorId, "est2");
  // next call from the same person goes to est2
  const again = await createLead(s, base({ divisions: ["roofing"] }), now);
  assert.equal(again.route.via, "last_estimator");
  assert.equal(s.jobs[1].estimatorId, "est2");
});

test("create: validation", async () => {
  const s = setup();
  assert.equal(await code(createLead(s, base({ customer: { firstName: "", lastName: "Lee", phone: "4175550199" } }), now)), "name_invalid");
  assert.equal(await code(createLead(s, base({ customer: { firstName: "Pat", lastName: "Lee" } }), now)), "contact_required");
  assert.equal(await code(createLead(s, base({ customer: { firstName: "Pat", lastName: "Lee", phone: "555-0101" } }), now)), "phone_invalid");
  assert.equal(await code(createLead(s, base({ customer: { firstName: "Pat", lastName: "Lee", email: "nope" } }), now)), "email_invalid");
  assert.equal(await code(createLead(s, base({ property: { street: "", city: "x", zip: "65775" } }), now)), "address_invalid");
  assert.equal(await code(createLead(s, base({ property: { street: "1 A St", city: "x", zip: "6577" } }), now)), "address_invalid");
  assert.equal(await code(createLead(s, base({ market: "mars" }), now)), "market_invalid");
  assert.equal(await code(createLead(s, base({ jobType: "solar" }), now)), "job_type_invalid");
  assert.equal(await code(createLead(s, base({ divisions: [] }), now)), "division_invalid");
  assert.equal(await code(createLead(s, base({ divisions: ["solar"] }), now)), "division_invalid");
  assert.equal(await code(createLead(s, base({ source: "billboard" }), now)), "source_invalid");
  assert.equal(await code(createLead(s, base({ appointmentAt: new Date("2020-01-01") }), now)), "appointment_invalid");
  assert.equal(await code(createLead(s, base({ appointmentAt: new Date("2030-01-01") }), now)), "appointment_invalid");
  assert.equal(await code(createLead(s, base({ overrideEstimatorId: "not-an-estimator" }), now)), "estimator_invalid");
  assert.equal(s.jobs.length, 0);
  assert.equal(s.customers.length, 1); // failed validation created nothing
});

test("create: a failure partway rolls everything back", async () => {
  const s = setup();
  s.pms = [];
  const real = s.transaction.bind(s);
  s.transaction = (async (fn: Parameters<typeof real>[0]) => real(async (tx) => {
    const wrapped = { ...tx, addHistory: async () => { throw new Error("db hiccup"); } };
    return fn(wrapped);
  })) as typeof s.transaction;
  await assert.rejects(() => createLead(s, base(), now), /db hiccup/);
  assert.equal(s.jobs.length, 0);
  assert.equal(s.customers.length, 1);
});

test("search: too short is refused; finds by phone, name and street", async () => {
  const s = setup();
  assert.equal(await code(searchCustomers(s, "Da")), "query_too_short");
  assert.equal(await code(searchCustomers(s, "  12 ")), "query_too_short");
  assert.equal((await searchCustomers(s, "417-555-0101")).length, 1);
  assert.equal((await searchCustomers(s, "555-0101"))[0].firstName, "Dana");
  assert.equal((await searchCustomers(s, "dana mil")).length, 1);
  assert.equal((await searchCustomers(s, "example rd")).length, 1);
  assert.equal((await searchCustomers(s, "nobody")).length, 0);
});

test("website lead: lands in review, unassigned, guessed market, message logged; same phone reuses the customer", async () => {
  const s = setup();
  const r = await createWebsiteLead(s, { firstName: "Dana", lastName: "Miller", phone: "417 555 0101", street: "100 Example Rd", city: "West Plains", zip: "65775", division: "roofing", message: "Hail damage" });
  const job = s.jobs.find((j) => j.id === r.jobId)!;
  assert.equal(job.needsReview, true);
  assert.equal(job.source, "website");
  assert.equal(job.estimatorId, null);
  assert.equal(job.productionManagerId, null);
  assert.equal(s.customers.length, 1);
  assert.equal(s.properties.length, 1);
  assert.deepEqual(s.events[0], { system: "website_form", payload: { jobId: r.jobId, message: "Hail damage" } });
  assert.equal((await s.listReviewQueue()).length, 1);
});

test("website lead: bad input creates nothing", async () => {
  const s = setup();
  const good = { firstName: "A", lastName: "B", phone: "4175550177", street: "1 A St", city: "X", zip: "65775", division: "roofing" };
  assert.equal(await code(createWebsiteLead(s, { ...good, division: "solar" })), "division_invalid");
  assert.equal(await code(createWebsiteLead(s, { ...good, phone: "12" })), "phone_invalid");
  assert.equal(await code(createWebsiteLead(s, { ...good, zip: "abc" })), "address_invalid");
  assert.equal(s.jobs.length, 0);
});

test("confirm: sets market, routes, and clears the review flag; only once", async () => {
  const s = setup();
  const r = await createWebsiteLead(s, { firstName: "Pat", lastName: "Lee", phone: "4175550199", street: "5 Hilltop Dr", city: "WS", zip: "65793", division: "siding" });
  const out = await confirmLead(s, { jobId: r.jobId, market: "springfield", jobType: "insurance", divisions: ["siding"] });
  assert.equal(out.route.via, "division_pm");
  const job = s.jobs.find((j) => j.id === r.jobId)!;
  assert.equal(job.needsReview, false);
  assert.equal(job.jobType, "insurance");
  assert.equal(job.productionManagerId, "pm-siding");
  assert.equal(s.properties.find((p) => p.id === job.propertyId)?.market, "springfield");
  assert.equal(await code(confirmLead(s, { jobId: r.jobId, market: "springfield", divisions: ["siding"] })), "not_in_review");
  assert.equal(await code(confirmLead(s, { jobId: "nope", market: "springfield", divisions: ["siding"] })), "not_found");
});

test("confirm: an existing customer's online lead routes to their last estimator", async () => {
  const s = setup();
  const r = await createWebsiteLead(s, { firstName: "Dana", lastName: "Miller", phone: "4175550101", street: "100 Example Rd", city: "West Plains", zip: "65775", division: "roofing" });
  const out = await confirmLead(s, { jobId: r.jobId, market: "west_plains", divisions: ["roofing"] });
  assert.equal(out.route.estimatorId, "est1");
});

test("ad spend: dollars and cents exactly, zero allowed, junk rejected", () => {
  assert.equal(parseSpendCents("1,250.50"), 125_050);
  assert.equal(parseSpendCents("0"), 0);
  assert.equal(parseSpendCents("$200"), 20_000);
  assert.equal(parseSpendCents("19.99"), 1_999);
  for (const bad of ["", "-5", "abc", "1.005", "1,23", "99999999999999"]) assert.equal(parseSpendCents(bad), null, bad);
});

test("ad spend: upserts per source and month; bad source, month or amount refused", async () => {
  const s = setup();
  await setMarketingSpend(s, { source: "facebook", month: "2026-10", amountText: "1,500" }, now);
  await setMarketingSpend(s, { source: "facebook", month: "2026-10", amountText: "0" }, now);
  assert.deepEqual(await s.listSpend("2026-10", "2026-10"), [{ source: "facebook", month: "2026-10", spendCents: 0 }]);
  assert.equal(await code(setMarketingSpend(s, { source: "billboard", month: "2026-10", amountText: "1" }, now)), "source_invalid");
  assert.equal(await code(setMarketingSpend(s, { source: "phone", month: "2026-13", amountText: "1" }, now)), "month_invalid");
  assert.equal(await code(setMarketingSpend(s, { source: "phone", month: "2026-10-01", amountText: "1" }, now)), "month_invalid");
  assert.equal(await code(setMarketingSpend(s, { source: "phone", month: "2015-01", amountText: "1" }, now)), "month_invalid");
  assert.equal(await code(setMarketingSpend(s, { source: "phone", month: "2026-10", amountText: "ten" }, now)), "amount_invalid");
});

test("roles: only CSR and admin take leads", () => {
  assert.ok(canTakeLeads("csr") && canTakeLeads("admin"));
  for (const r of ["estimator", "production_manager", "crew_leader", "accounting"] as const) assert.ok(!canTakeLeads(r), r);
});
