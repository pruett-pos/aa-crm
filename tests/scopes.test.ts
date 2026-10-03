import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeScope, canReadScopes, canWriteScopes, toView, ScopeInputError,
} from "../src/lib/scopes/service.ts";
import type { Product, JobAccess } from "../src/lib/scopes/types.ts";
import type { AuthUser } from "../src/lib/auth/store.ts";
import type { Role } from "../src/lib/auth/roles.ts";

const catalog: Product[] = [
  { id: "p1", sku: "S1", name: "Shingles", unit: "sq", retailCents: 13_500, specialOrder: false }, // Builder: $118.80
];
const user = (id: string, role: Role): AuthUser => ({ id, fullName: id, email: `${id}@x.com`, role, active: true });
const job = (over: Partial<JobAccess> = {}): JobAccess => ({
  id: "j1", stage: "scope_presented", divisions: ["siding"], estimatorId: "est1", productionManagerId: null, ...over,
});

test("computeScope: materials cost the Pruett Builder price, price comes from target margin", () => {
  const s = computeScope({
    tier: "good", title: "Good", targetMarginBps: 4000,
    items: [{ kind: "material", productId: "p1", quantity: 10 }],
  }, catalog);
  assert.equal(s.items[0].unitCostCents, 11_880);   // 13,500 less 12%
  assert.equal(s.items[0].unitPriceCents, 19_800);  // 11,880 / 0.6
  assert.equal(s.costCents, 118_800);
  assert.equal(s.saleCents, 198_000);
  assert.equal(s.marginBps, 4000);
});

test("computeScope: labor line uses typed cost; margin lands at target", () => {
  const s = computeScope({
    tier: "better", title: "Better", targetMarginBps: 3800,
    items: [
      { kind: "material", productId: "p1", quantity: 20 },
      { kind: "labor", description: "Tear-off and install", quantity: 20, unitCostCents: 9_000 },
    ],
  }, catalog);
  assert.equal(s.marginBps, 3800);
});

test("computeScope: client cannot supply a price or cost for a material", () => {
  const s = computeScope({
    tier: "good", title: "Good", targetMarginBps: 4000,
    items: [{ kind: "material", productId: "p1", quantity: 1, unitCostCents: 1, unitPriceCents: 1 } as never],
  }, catalog);
  assert.equal(s.items[0].unitCostCents, 11_880);
  assert.equal(s.items[0].unitPriceCents, 19_800);
});

test("computeScope: rejects bad input", () => {
  const base = { tier: "good" as const, title: "Good", targetMarginBps: 4000, items: [] };
  assert.throws(() => computeScope({ ...base, title: "  " }, catalog), ScopeInputError);
  assert.throws(() => computeScope({ ...base, targetMarginBps: 9600 }, catalog), ScopeInputError);
  assert.throws(() => computeScope({ ...base, targetMarginBps: 40.5 }, catalog), ScopeInputError);
  assert.throws(() => computeScope({ ...base, items: [{ kind: "material", productId: "nope", quantity: 1 }] }, catalog), ScopeInputError);
  assert.throws(() => computeScope({ ...base, items: [{ kind: "material", productId: "p1", quantity: 0 }] }, catalog), ScopeInputError);
  assert.throws(() => computeScope({ ...base, items: [{ kind: "labor", quantity: 1, unitCostCents: 100 }] }, catalog), ScopeInputError);
  assert.throws(() => computeScope({ ...base, items: [{ kind: "labor", description: "x", quantity: 1 }] }, catalog), ScopeInputError);
  assert.equal(computeScope(base, catalog).saleCents, 0); // empty scope is fine
});

test("access: write is admin or the job's own estimator only", () => {
  assert.ok(canWriteScopes(user("a", "admin"), job()));
  assert.ok(canWriteScopes(user("est1", "estimator"), job()));
  assert.ok(!canWriteScopes(user("est2", "estimator"), job()));
  assert.ok(!canWriteScopes(user("pm", "production_manager"), job()));
  assert.ok(!canWriteScopes(user("c", "csr"), job()));
});

test("access: PM reads only their division's jobs from contract onward", () => {
  const pm = user("pm", "production_manager");
  assert.ok(!canReadScopes(pm, job({ stage: "scope_presented" }), ["pm"]));   // before contract
  assert.ok(canReadScopes(pm, job({ stage: "contract_signed" }), ["pm"]));
  assert.ok(canReadScopes(pm, job({ stage: "in_production" }), ["pm"]));
  assert.ok(!canReadScopes(pm, job({ stage: "contract_signed" }), ["other-pm"])); // not their division
  assert.ok(canReadScopes(pm, job({ stage: "contract_signed", productionManagerId: "pm" }), []));
});

test("access: csr, crew leader, accounting, other estimators cannot read", () => {
  for (const role of ["csr", "crew_leader", "accounting"] as const) {
    assert.ok(!canReadScopes(user("u", role), job({ stage: "contract_signed" }), ["u"]));
  }
  assert.ok(!canReadScopes(user("est2", "estimator"), job(), []));
});

const stored = () => ({
  id: "s1",
  ...computeScope({
    tier: "good", title: "Good", targetMarginBps: 3800,
    items: [{ kind: "material", productId: "p1", quantity: 10 }],
  }, catalog),
});

test("view: PM sees margin and cost but not commission", () => {
  const v = toView(stored(), "production_manager", { isOwnJobEstimator: false, estimatorOwnTruck: false });
  assert.equal(v.marginBps, 3800);
  assert.ok(v.costCents !== undefined);
  assert.equal(v.commissionRateBps, undefined);
});

test("view: own estimator sees margin and commission preview (38% -> 7%)", () => {
  const v = toView(stored(), "estimator", { isOwnJobEstimator: true, estimatorOwnTruck: false });
  assert.equal(v.marginBps, 3800);
  assert.equal(v.commissionRateBps, 700);
  const truck = toView(stored(), "estimator", { isOwnJobEstimator: true, estimatorOwnTruck: true });
  assert.equal(truck.commissionRateBps, 900);
});

test("view: roles without margin access get price only, no cost fields anywhere", () => {
  const v = toView(stored(), "csr", { isOwnJobEstimator: false, estimatorOwnTruck: false });
  assert.equal(v.marginBps, undefined);
  assert.equal(v.costCents, undefined);
  assert.equal(v.targetMarginBps, undefined);
  assert.equal(v.commissionRateBps, undefined);
  assert.ok(v.saleCents > 0);
  assert.ok(v.items.every((i) => !("unitCostCents" in i)));
  assert.ok(!JSON.stringify(v).includes("costCents"));
});
