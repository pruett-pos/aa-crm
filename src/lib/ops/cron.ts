// Runs a scheduled job script as a child process and reports failure. Used by scripts/run-cron.ts so the job scripts
// themselves stay simple. A failure is: a non-zero exit, a crash, or running past the time limit.
import { spawn } from "node:child_process";
import { logError, logInfo, redact } from "./log.ts";

const TAIL_BYTES = 3000;

export type CronOutcome = { ok: boolean; exitCode: number; reason: string; outputTail: string };
export type Alerter = (a: { job: string; reason: string; outputTail: string; at: Date }) => Promise<boolean>;

/** Keep only the end of the output, with anything secret-looking removed. */
export function tailOf(text: string): string {
  return redact(text.length > TAIL_BYTES ? text.slice(-TAIL_BYTES) : text);
}

export function runChild(command: string, args: string[], opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<CronOutcome> {
  return new Promise((resolve) => {
    let tail = "";
    let timedOut = false;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: opts.env ?? process.env });
    const keep = (chunk: Buffer, out: NodeJS.WriteStream) => {
      out.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-TAIL_BYTES * 2);
    };
    child.stdout.on("data", (c: Buffer) => keep(c, process.stdout));
    child.stderr.on("data", (c: Buffer) => keep(c, process.stderr));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: 1, reason: `Could not start the job: ${e.message}`, outputTail: tailOf(tail) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, exitCode: 124, reason: `The job ran longer than ${Math.round(opts.timeoutMs / 60000)} minutes and was stopped.`, outputTail: tailOf(tail) });
      if (code === 0) return resolve({ ok: true, exitCode: 0, reason: "", outputTail: tailOf(tail) });
      resolve({ ok: false, exitCode: code ?? 1, reason: signal ? `The job was killed by ${signal}.` : `The job exited with code ${code}.`, outputTail: tailOf(tail) });
    });
  });
}

/** Runs the job, logs the result, emails on failure. Returns the exit code the process should use. */
export async function runCronJob(
  job: string, command: string, args: string[],
  opts: { timeoutMs?: number; alert: Alerter; env?: NodeJS.ProcessEnv; now?: () => Date },
): Promise<number> {
  const started = Date.now();
  const outcome = await runChild(command, args, { timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000, env: opts.env });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (outcome.ok) {
    logInfo("cron.ok", { job, seconds });
    return 0;
  }
  logError("cron.failed", new Error(outcome.reason), { job, exitCode: outcome.exitCode, seconds });
  try {
    const sent = await opts.alert({ job, reason: outcome.reason, outputTail: outcome.outputTail, at: (opts.now ?? (() => new Date()))() });
    if (!sent) logError("cron.alert_not_sent", new Error("ALERT_EMAILS, RESEND_API_KEY or EMAIL_FROM is not set"), { job });
  } catch (e) {
    logError("cron.alert_failed", e, { job });
  }
  return outcome.exitCode === 0 ? 1 : outcome.exitCode;
}
