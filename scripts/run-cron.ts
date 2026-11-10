// Wraps a scheduled job so a failure exits non-zero AND emails ALERT_EMAILS.
//
//   node --experimental-strip-types scripts/run-cron.ts <job-name> <script.ts> [script args...]
//
// Railway cron services run this through `npm run cron:pruett` and `npm run cron:companycam`.
// The wrapped script keeps its own behavior (dry run unless it is given --apply, and so on).
import { sendCronFailureAlert } from "../src/integrations/resend/index.ts";
import { runCronJob } from "../src/lib/ops/cron.ts";
import { logError } from "../src/lib/ops/log.ts";

const [job, script, ...rest] = process.argv.slice(2);
if (!job || !script) {
  console.error("usage: run-cron.ts <job-name> <script.ts> [args...]");
  process.exit(2);
}

try {
  const code = await runCronJob(job, process.execPath, ["--experimental-strip-types", script, ...rest], { alert: sendCronFailureAlert });
  process.exit(code);
} catch (e) {
  logError("cron.wrapper_crashed", e, { job });
  process.exit(1);
}
