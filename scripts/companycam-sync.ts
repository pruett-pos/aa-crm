// Retry tool: create or link CompanyCam projects for jobs that don't have one yet (pending, failed, or created before
// CompanyCam was connected). Meant to run on a schedule (Railway cron) and by hand.
//
// DRY RUN by default: it only lists the jobs it would send. Nothing is created in CompanyCam until you add --apply,
// so connecting a real account never pushes every old job in by accident.
//
//   node --env-file=.env --experimental-strip-types scripts/companycam-sync.ts                  (dry run)
//   node --env-file=.env --experimental-strip-types scripts/companycam-sync.ts --apply          (do it)
//   node --env-file=.env --experimental-strip-types scripts/companycam-sync.ts --apply --limit 10
//
import { getDb } from "../src/lib/db.ts";
import { getCompanyCamClient, getCompanyCamStore } from "../src/lib/companycam/index.ts";
import { MAX_ATTEMPTS, ensureProject, projectName } from "../src/lib/companycam/logic.ts";

const apply = process.argv.includes("--apply");
const li = process.argv.indexOf("--limit");
const limit = li >= 0 ? Math.max(1, Math.min(500, Number(process.argv[li + 1]) || 25)) : 25;

const client = getCompanyCamClient();
if (!client) {
  console.log("CompanyCam is not connected: COMPANYCAM_ACCESS_TOKEN is not set. Nothing to do.");
  process.exit(0);
}

const store = getCompanyCamStore();
const jobs = await store.listNeedingSync(limit, new Date(), MAX_ATTEMPTS);
console.log(`${jobs.length} job(s) need a CompanyCam project${apply ? "" : " (dry run; add --apply to send)"}`);

const tally: Record<string, number> = {};
for (const job of jobs) {
  if (!apply) {
    console.log(`  would sync job ${job.jobNumber}: ${projectName(job)}`);
    continue;
  }
  const r = await ensureProject(store, client, job.id);
  const key = r.status === "error" ? `error:${r.kind}` : r.status === "skipped" ? `skipped:${r.reason}` : r.status;
  tally[key] = (tally[key] ?? 0) + 1;
  console.log(`  job ${job.jobNumber}: ${key}`);
  if (r.status === "error" && r.kind === "auth") {
    console.log("Stopping: CompanyCam rejected the access token. Fix COMPANYCAM_ACCESS_TOKEN, then run again.");
    break;
  }
  await new Promise((res) => setTimeout(res, 300));   // gentle pacing; rate limits are not documented
}
if (apply) console.log(JSON.stringify(tally));
await getDb().$disconnect();
