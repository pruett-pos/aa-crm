import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "../src/lib/auth/roles.ts";
import type { AuthUser } from "../src/lib/auth/store.ts";
import { MemoryUserAdminStore } from "../src/lib/users/memory-store.ts";
import { UserError, addUser, changeUser, cleanPhone, listUsers, type UserErrorCode } from "../src/lib/users/service.ts";

function setup() {
  const store = new MemoryUserAdminStore();
  const admin = store.seed({ fullName: "AL Admin", email: "al@x.com", role: "admin" });
  const actor: AuthUser = { id: admin.id, fullName: admin.fullName, email: admin.email, role: "admin", active: true };
  return { store, admin, actor };
}
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "ok"; } catch (e) { return e instanceof UserError ? e.code : `other:${e}`; } };
const asRole = (actor: AuthUser, role: AuthUser["role"]): AuthUser => ({ ...actor, role });
const base = { fullName: "Pat Smith", email: "pat@x.com", role: "estimator" };

test("role check: only an active admin can list, add or change users", async () => {
  const { store, actor, admin } = setup();
  for (const role of ROLES) {
    const a = asRole(actor, role);
    const expected = role === "admin" ? "ok" : "forbidden";
    assert.equal(await code(listUsers(store, a)), expected, `list as ${role}`);
    assert.equal(await code(addUser(store, a, { ...base, email: `${role}@x.com` })), expected, `add as ${role}`);
    assert.equal(await code(changeUser(store, a, admin.id, { phone: "417-555-0100" })), expected, `change as ${role}`);
  }
  assert.equal(await code(listUsers(store, { ...actor, active: false })), "forbidden", "a deactivated admin is not an admin");
  assert.deepEqual(store.users.map((u) => u.email).sort(), ["admin@x.com", "al@x.com"], "nothing was created by the non-admins");
  assert.equal(store.audits.filter((a) => a.actorId !== actor.id).length, 0);
});

test("add: details are cleaned, the email is lowercased, and an audit entry names the actor", async () => {
  const { store, actor } = setup();
  const u = await addUser(store, actor, { fullName: "  Pat   Smith ", email: " Pat@X.com ", phone: "417.555.0123", role: "csr", market: "west_plains" });
  assert.deepEqual([u.fullName, u.email, u.phone, u.role, u.market, u.active], ["Pat Smith", "pat@x.com", "(417) 555-0123", "csr", "west_plains", true]);
  assert.equal(store.audits.length, 1);
  assert.equal(store.audits[0].action, "user.created");
  assert.equal(store.audits[0].actorId, actor.id);
  assert.equal(store.audits[0].entityId, u.id);
});

test("add: validation", async () => {
  const { store, actor } = setup();
  const cases: [Record<string, unknown>, UserErrorCode][] = [
    [{ fullName: "A" }, "invalid_name"], [{ email: "nope" }, "invalid_email"], [{ phone: "123" }, "invalid_phone"],
    [{ role: "owner" }, "invalid_role"], [{ market: "mars" }, "invalid_market"], [{ email: "AL@x.com" }, "duplicate_email"],
    [{ role: "production_manager", divisions: ["solar"], market: "west_plains" }, "invalid_division"],
    [{ role: "production_manager", divisions: ["roofing"] }, "market_required"],
  ];
  for (const [over, expected] of cases) assert.equal(await code(addUser(store, actor, { ...base, ...over })), expected, JSON.stringify(over));
  assert.equal(store.users.length, 1);
  assert.equal(store.audits.length, 0, "a refused add leaves no audit entry");
});

test("phone: blank is fine, a leading 1 is dropped, anything else must be 10 digits", () => {
  assert.equal(cleanPhone(""), null);
  assert.equal(cleanPhone(undefined), null);
  assert.equal(cleanPhone("1 (417) 555-0123"), "(417) 555-0123");
  assert.throws(() => cleanPhone("555-0123"), UserError);
});

test("crew leaders can be added like anyone else", async () => {
  const { store, actor } = setup();
  const u = await addUser(store, actor, { fullName: "Crew Three", email: "crew3@x.com", role: "crew_leader", market: "springfield", phone: "4175550199" });
  assert.equal(u.role, "crew_leader");
});

test("production manager: divisions are assigned in their market, and one PM per division per market", async () => {
  const { store, actor } = setup();
  const a = await addUser(store, actor, { fullName: "Pm One", email: "pm1@x.com", role: "production_manager", market: "west_plains", divisions: ["roofing", "siding", "roofing"] });
  assert.deepEqual(a.divisions.sort(), ["roofing", "siding"]);
  assert.equal(await code(addUser(store, actor, { fullName: "Pm Two", email: "pm2@x.com", role: "production_manager", market: "west_plains", divisions: ["siding"] })), "division_taken");
  const ok = await addUser(store, actor, { fullName: "Pm Two", email: "pm2@x.com", role: "production_manager", market: "springfield", divisions: ["siding"] });
  assert.deepEqual(ok.divisions, ["siding"]);
});

test("change role: audited with before and after, ends the person's sessions, drops divisions when leaving PM", async () => {
  const { store, actor } = setup();
  const pm = await addUser(store, actor, { fullName: "Pm One", email: "pm1@x.com", role: "production_manager", market: "west_plains", divisions: ["roofing"] });
  const r = await changeUser(store, actor, pm.id, { role: "estimator" });
  assert.equal(r.role, "estimator");
  assert.deepEqual(r.divisions, []);
  assert.deepEqual(store.managers, [], "lead routing no longer points at them");
  assert.ok(store.revoked.includes(pm.id));
  const kinds = store.audits.map((a) => a.action);
  assert.ok(kinds.includes("user.role_changed") && kinds.includes("user.divisions_changed"));
  assert.deepEqual(store.audits.find((a) => a.action === "user.role_changed")!.details, { from: "production_manager", to: "estimator" });
});

test("deactivate and reactivate: sessions end, divisions are cleared, both are audited", async () => {
  const { store, actor } = setup();
  const pm = await addUser(store, actor, { fullName: "Pm One", email: "pm1@x.com", role: "production_manager", market: "west_plains", divisions: ["gutters"] });
  const off = await changeUser(store, actor, pm.id, { active: false });
  assert.equal(off.active, false);
  assert.deepEqual(off.divisions, []);
  assert.ok(store.revoked.includes(pm.id));
  const on = await changeUser(store, actor, pm.id, { active: true });
  assert.equal(on.active, true);
  assert.deepEqual(store.audits.map((a) => a.action).filter((a) => a !== "user.created"), ["user.deactivated", "user.divisions_changed", "user.reactivated"]);
});

test("an admin cannot change their own role, deactivate themselves, or change their own email", async () => {
  const { store, actor, admin } = setup();
  assert.equal(await code(changeUser(store, actor, admin.id, { role: "csr" })), "cannot_change_own_role");
  assert.equal(await code(changeUser(store, actor, admin.id, { active: false })), "cannot_deactivate_self");
  assert.equal(await code(changeUser(store, actor, admin.id, { email: "new@x.com" })), "cannot_change_own_email");
  assert.equal(store.users[0].role, "admin");
  assert.equal(store.audits.length, 0);
  // but name and phone are fine, and re-sending the same role is not a change
  const r = await changeUser(store, actor, admin.id, { fullName: "Al K", role: "admin", phone: "417-555-0100" });
  assert.deepEqual([r.fullName, r.phone, r.role], ["Al K", "(417) 555-0100", "admin"]);
});

test("another admin can be demoted or turned off, because the acting admin remains", async () => {
  const { store, actor } = setup();
  const b = store.seed({ fullName: "Second Admin", email: "b@x.com", role: "admin" });
  assert.equal((await changeUser(store, actor, b.id, { active: false })).active, false);
});

test("a change that changes nothing writes nothing", async () => {
  const { store, actor } = setup();
  const u = await addUser(store, actor, base);
  const n = store.audits.length;
  await changeUser(store, actor, u.id, { fullName: u.fullName, role: u.role, email: u.email });
  assert.equal(store.audits.length, n);
});

test("change: email must stay unique, unknown users are not found, non-PMs cannot take divisions", async () => {
  const { store, actor } = setup();
  const u = await addUser(store, actor, base);
  assert.equal(await code(changeUser(store, actor, u.id, { email: "AL@x.com" })), "duplicate_email");
  assert.equal(await code(changeUser(store, actor, "nope", { phone: "" })), "not_found");
  assert.equal(await code(changeUser(store, actor, u.id, { divisions: ["roofing"] })), "not_a_manager");
});

test("moving a PM to another market moves their divisions with them, and checks that market is free", async () => {
  const { store, actor } = setup();
  const a = await addUser(store, actor, { fullName: "Pm One", email: "pm1@x.com", role: "production_manager", market: "west_plains", divisions: ["roofing"] });
  await addUser(store, actor, { fullName: "Pm Two", email: "pm2@x.com", role: "production_manager", market: "springfield", divisions: ["roofing"] });
  assert.equal(await code(changeUser(store, actor, a.id, { market: "springfield" })), "division_taken");
  const r = await changeUser(store, actor, a.id, { market: "nw_arkansas" });
  assert.deepEqual(store.managers.filter((m) => m.userId === a.id), [{ division: "roofing", market: "nw_arkansas", userId: a.id }]);
  assert.equal(r.market, "nw_arkansas");
});
