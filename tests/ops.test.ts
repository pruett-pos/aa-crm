import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError, logError, logInfo, scrub, setLogSinks } from "../src/lib/ops/log.ts";
import { runChild, runCronJob, tailOf } from "../src/lib/ops/cron.ts";
import { checkHealth } from "../src/lib/ops/health.ts";
import { parseAlertEmails } from "../src/integrations/resend/index.ts";
import { STATIC_SECURITY_HEADERS, buildCsp, newNonce } from "../src/lib/security-headers.ts";

const node = process.execPath;

test("log lines are one JSON object with level, time, event and error details", () => {
  const out: string[] = [];
  setLogSinks({ error: (l) => out.push(l), info: (l) => out.push(l) });
  logInfo("thing.happened", { jobId: 7 });
  logError("thing.failed", new Error("kaput"), { jobId: 7 });
  const [info, err] = out.map((l) => JSON.parse(l));
  assert.deepEqual([info.level, info.event, info.jobId], ["info", "thing.happened", 7]);
  assert.deepEqual([err.level, err.event, err.error.message, err.error.name], ["error", "thing.failed", "kaput", "Error"]);
  assert.match(err.ts, /^\d{4}-\d\d-\d\dT/);
  assert.ok(err.error.stack.includes("kaput"));
});

test("logs never carry secrets: secret-looking keys, bearer tokens and database passwords are removed", () => {
  const s = scrub({ token: "abc", nested: { Authorization: "Bearer zzz", apiKey: "k", ok: "fine" }, url: "postgresql://user:hunter2@host/db", msg: "got Bearer abc.def-123 here" }) as Record<string, any>;
  assert.equal(s.token, "[redacted]");
  assert.equal(s.nested.Authorization, "[redacted]");
  assert.equal(s.nested.apiKey, "[redacted]");
  assert.equal(s.nested.ok, "fine");
  assert.ok(!s.url.includes("hunter2"));
  assert.ok(!s.msg.includes("abc.def-123"));
  const e = describeError(new Error("connect postgresql://u:pw123@h/d failed"));
  assert.ok(!e.message.includes("pw123"));
});

test("non-Error throws are logged too", () => {
  assert.equal(describeError("just a string").message, "just a string");
  assert.equal(describeError({ a: 1 }).name, "NonError");
});

test("cron: a job that exits 0 is ok; no alert is sent", async () => {
  let alerts = 0;
  const code = await runCronJob("t", node, ["-e", "0"], { alert: async () => { alerts++; return true; } });
  assert.equal(code, 0);
  assert.equal(alerts, 0);
});

test("cron: a job that exits non-zero fails the run with the same code, and sends one alert with the output tail", async () => {
  const sent: { job: string; reason: string; outputTail: string }[] = [];
  setLogSinks({ error: () => undefined });
  const code = await runCronJob("pruett", node, ["-e", "console.error('feed refused, Bearer sekrit123'); process.exit(3)"], {
    alert: async (a) => { sent.push(a); return true; }, now: () => new Date("2026-11-10T08:00:00Z"),
  });
  assert.equal(code, 3);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].job, "pruett");
  assert.match(sent[0].reason, /exited with code 3/);
  assert.match(sent[0].outputTail, /feed refused/);
  assert.ok(!sent[0].outputTail.includes("sekrit123"), "tokens are scrubbed from the emailed output");
});

test("cron: a crash (uncaught exception) is a failure", async () => {
  setLogSinks({ error: () => undefined });
  let alerts = 0;
  const code = await runCronJob("x", node, ["-e", "throw new Error('boom')"], { alert: async () => { alerts++; return true; } });
  assert.notEqual(code, 0);
  assert.equal(alerts, 1);
});

test("cron: a job that cannot even start fails and alerts", async () => {
  setLogSinks({ error: () => undefined });
  let alerts = 0;
  const code = await runCronJob("x", "/definitely/not/a/program", [], { alert: async () => { alerts++; return true; } });
  assert.notEqual(code, 0);
  assert.equal(alerts, 1);
});

test("cron: a job that runs too long is stopped and fails", async () => {
  setLogSinks({ error: () => undefined });
  const r = await runChild(node, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 150 });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 124);
});

test("cron: still exits non-zero when the alert email itself fails or nobody is configured", async () => {
  setLogSinks({ error: () => undefined });
  assert.equal(await runCronJob("x", node, ["-e", "process.exit(1)"], { alert: async () => { throw new Error("resend down"); } }), 1);
  assert.equal(await runCronJob("x", node, ["-e", "process.exit(1)"], { alert: async () => false }), 1);
});

test("output tail keeps only the end", () => {
  const t = tailOf("a".repeat(10_000) + "THE END");
  assert.ok(t.length <= 3100 && t.endsWith("THE END"));
});

test("ALERT_EMAILS: commas, spaces and semicolons split; junk is dropped", () => {
  assert.deepEqual(parseAlertEmails("al@x.com, ops@y.org;  bad , @x.com,second@z.io"), ["al@x.com", "ops@y.org", "second@z.io"]);
  assert.deepEqual(parseAlertEmails(undefined), []);
  assert.deepEqual(parseAlertEmails(""), []);
});

test("health: ok when the database answers, 503 when it errors or hangs; no error text leaks", async () => {
  assert.deepEqual(await checkHealth(async () => 1), { status: 200, body: { status: "ok", db: "ok" } });
  const down = await checkHealth(async () => { throw new Error("password authentication failed for user x"); });
  assert.deepEqual(down, { status: 503, body: { status: "down", db: "down" } });
  const hung = await checkHealth(() => new Promise(() => undefined), 30);
  assert.equal(hung.status, 503);
});

test("security headers: framing is same-origin only, nosniff, referrer policy, HSTS", () => {
  const h = Object.fromEntries(STATIC_SECURITY_HEADERS.map((x) => [x.key, x.value]));
  assert.equal(h["X-Frame-Options"], "SAMEORIGIN");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.match(h["Strict-Transport-Security"], /max-age=\d{7,}/);
});

test("CSP: scripts need the per-request nonce, no eval in production, no plugins, no framing by others", () => {
  const n = newNonce();
  assert.notEqual(n, newNonce());
  const csp = buildCsp(n, { dev: false });
  assert.match(csp, new RegExp(`script-src 'self' 'nonce-${n.replace(/[+/=]/g, "\\$&")}' 'strict-dynamic'`));
  assert.ok(!csp.includes("unsafe-eval"));
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.ok(csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'self'") && csp.includes("base-uri 'self'") && csp.includes("form-action 'self'"));
  assert.ok(csp.includes("upgrade-insecure-requests"));
  assert.ok(buildCsp(n, { dev: true }).includes("'unsafe-eval'"), "dev needs eval for React's error stacks");
});
