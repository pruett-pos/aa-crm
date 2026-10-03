import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closedPeriods, isClosed, isDateString, isPeriodEnd, localDate, periodContaining, ScheduleError, validateSchedule,
  type Schedule,
} from "../src/lib/commission/periods.ts";

const weekly: Schedule = { cadence: "weekly", anchorDate: "2026-10-09" };        // periods end on Fridays
const biweekly: Schedule = { cadence: "biweekly", anchorDate: "2026-10-09" };
const semi: Schedule = { cadence: "semimonthly", anchorDate: null };
const monthly: Schedule = { cadence: "monthly", anchorDate: null };

test("weekly: Saturday to Friday around the anchor", () => {
  assert.deepEqual(periodContaining("2026-10-09", weekly), { start: "2026-10-03", end: "2026-10-09" }); // the end day itself
  assert.deepEqual(periodContaining("2026-10-03", weekly), { start: "2026-10-03", end: "2026-10-09" });
  assert.deepEqual(periodContaining("2026-10-10", weekly), { start: "2026-10-10", end: "2026-10-16" });
  assert.deepEqual(periodContaining("2026-09-30", weekly), { start: "2026-09-26", end: "2026-10-02" }); // before the anchor
});

test("biweekly: fourteen-day periods, before and after the anchor", () => {
  assert.deepEqual(periodContaining("2026-10-09", biweekly), { start: "2026-09-26", end: "2026-10-09" });
  assert.deepEqual(periodContaining("2026-10-10", biweekly), { start: "2026-10-10", end: "2026-10-23" });
  assert.deepEqual(periodContaining("2026-09-25", biweekly), { start: "2026-09-12", end: "2026-09-25" });
});

test("semimonthly: 1st to 15th, 16th to month end (Feb, leap Feb, 31-day months)", () => {
  assert.deepEqual(periodContaining("2026-10-15", semi), { start: "2026-10-01", end: "2026-10-15" });
  assert.deepEqual(periodContaining("2026-10-16", semi), { start: "2026-10-16", end: "2026-10-31" });
  assert.deepEqual(periodContaining("2026-02-20", semi), { start: "2026-02-16", end: "2026-02-28" });
  assert.deepEqual(periodContaining("2028-02-20", semi), { start: "2028-02-16", end: "2028-02-29" });
  assert.deepEqual(periodContaining("2026-04-30", semi), { start: "2026-04-16", end: "2026-04-30" });
});

test("monthly: whole calendar month", () => {
  assert.deepEqual(periodContaining("2026-12-31", monthly), { start: "2026-12-01", end: "2026-12-31" });
  assert.deepEqual(periodContaining("2028-02-01", monthly), { start: "2028-02-01", end: "2028-02-29" });
});

test("periods cover every day exactly once (no gaps or overlaps) for every cadence", () => {
  for (const s of [weekly, biweekly, semi, monthly]) {
    let prevEnd: string | null = null;
    let d = "2026-01-01";
    for (let i = 0; i < 400; i++) {
      const p = periodContaining(d, s);
      assert.ok(p.start <= d && d <= p.end, `${s.cadence} ${d}`);
      if (prevEnd && p.end !== prevEnd) {
        const next = new Date(Date.parse(`${prevEnd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        assert.equal(p.start, next, `gap or overlap before ${d} (${s.cadence})`);
      }
      prevEnd = p.end;
      d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    }
  }
});

test("a period is closed only after its last day has passed", () => {
  const p = { start: "2026-10-03", end: "2026-10-09" };
  assert.equal(isClosed(p, "2026-10-09"), false); // still the last day
  assert.equal(isClosed(p, "2026-10-10"), true);
});

test("closed periods go back from today, newest first", () => {
  const out = closedPeriods("2026-10-12", weekly, 3); // today is in the period 10-10 to 10-16
  assert.deepEqual(out, [
    { start: "2026-10-03", end: "2026-10-09" },
    { start: "2026-09-26", end: "2026-10-02" },
    { start: "2026-09-19", end: "2026-09-25" },
  ]);
  assert.deepEqual(closedPeriods("2026-10-01", semi, 2), [
    { start: "2026-09-16", end: "2026-09-30" }, { start: "2026-09-01", end: "2026-09-15" },
  ]);
});

test("period end checks", () => {
  assert.equal(isPeriodEnd("2026-10-09", weekly), true);
  assert.equal(isPeriodEnd("2026-10-08", weekly), false);
  assert.equal(isPeriodEnd("2026-10-15", semi), true);
  assert.equal(isPeriodEnd("2026-02-28", semi), true);
  assert.equal(isPeriodEnd("2026-02-15", monthly), false);
  assert.equal(isPeriodEnd("not-a-date", monthly), false);
});

test("local date uses Central time: 10 pm Central is already tomorrow in UTC", () => {
  assert.equal(localDate(new Date("2026-10-04T03:00:00Z")), "2026-10-03"); // 10 pm CDT on Oct 3
  assert.equal(localDate(new Date("2026-10-03T12:00:00Z")), "2026-10-03");
  assert.equal(localDate(new Date("2026-01-01T05:30:00Z")), "2025-12-31"); // 11:30 pm CST Dec 31
  assert.equal(localDate(new Date("2026-03-08T07:59:00Z")), "2026-03-08"); // around the spring-forward change
});

test("schedule validation and date checks", () => {
  assert.throws(() => validateSchedule({ cadence: "weekly", anchorDate: null }), ScheduleError);
  assert.throws(() => validateSchedule({ cadence: "biweekly", anchorDate: "2026-02-30" }), ScheduleError);
  assert.throws(() => validateSchedule({ cadence: "daily" as never, anchorDate: null }), ScheduleError);
  validateSchedule(semi);
  validateSchedule(monthly);
  assert.equal(isDateString("2026-02-29"), false);
  assert.equal(isDateString("2028-02-29"), true);
  assert.equal(isDateString("2026-1-1"), false);
  assert.throws(() => periodContaining("2026-13-01", monthly), ScheduleError);
});
