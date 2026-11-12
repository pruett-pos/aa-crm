# A&A CRM: operations

Plain-language runbook for deploying, changing the database, backups, settings and alerts.
Hosting: Railway, project `brilliant-surprise`, environment `production`, service `aa-crm` plus its own Postgres service
(private address only). Deploys come from GitHub `pruett-pos/aa-crm`, branch `main`.

Things marked **[confirm in Railway]** are about Railway's screens or plan limits. Those change, so check them in the
dashboard (or Railway's docs) rather than trusting this page.

---

## 1. Deploying

1. Open a pull request. CI (`.github/workflows/ci.yml`) runs `npm ci`, typecheck, `npm test` (against a Postgres 16 service) and `npm run build`. Do not merge on red.
2. Merge to `main`. Railway builds (`npm run build`) and starts (`npm start`).
3. `npm start` first runs `scripts/migrate.ts --on-start`, which applies any pending migrations (each in its own transaction), then starts the app.
   - If a migration fails it is rolled back, the start command exits, and Railway keeps the previous deployment running. Fix forward with a new migration.
   - If the database has never been baselined (see 2.2), it prints a WARNING, runs nothing, and starts anyway.
4. Railway's health check calls `GET /api/health`. It answers `{"status":"ok","db":"ok"}` (200) or `{"status":"down","db":"down"}` (503). It is public and reveals nothing else. Point an uptime monitor at it too (for example UptimeRobot, free) so a person is emailed if the site is down.
5. To roll back a bad deploy: Railway, `aa-crm`, Deployments, redeploy the previous one. Migrations are not undone. Keep every migration backward compatible with the previous code for one deploy (add columns, do not rename or drop in the same release).

**Node version.** `package.json` `engines` says `>=22.18 <23` and `.nvmrc` says `22.23.4` (what the tests were run on; GitHub Actions uses `.nvmrc`). The build needs Node 22.18 or newer (`--experimental-strip-types`). **[confirm in Railway]** In the build log of the next deploy, check the Node version it printed is 22.x. If it is not, set the service's Node version to 22 there.

## 2. Database migrations

### 2.1 How it works
- `db/schema.sql` is the reference schema and counts as migration `001_schema`. Every change after that is a file `db/migrations/NNN_short_name.sql` (three digits, lowercase). Files must not contain `BEGIN` or `COMMIT`: the runner wraps each one in a transaction.
- `schema_migrations` records every applied migration with a checksum. Each runs exactly once. If an applied file is edited afterwards the runner refuses to continue (put the change in a new migration).
- Two deploys starting together cannot both migrate (a database lock).
- Add a migration: create the file, add its entry to `src/lib/migrate/signatures.ts` (the tests check it), run `npm run db:migrate` locally, commit. **Do not edit `db/setup-production.sql`: it no longer exists.** It was a hand-pasted copy of the schema plus every migration, edited twice per change, and the runner builds a fresh database from the same files, so keeping it would only invite the two to drift apart.

Commands (run where `DATABASE_URL` is set; locally it reads `.env`):

```bash
npm run db:migrate -- --dry-run   # list pending migrations, change nothing
npm run db:migrate                # apply them
npm run db:baseline               # one time, production only: show what would be marked as applied (changes nothing)
npm run db:baseline -- --apply    # one time, production only: mark them
```

### 2.2 One-time baseline for production (do this once)

Production was created before the runner existed, so it has the tables but no `schema_migrations`. The baseline marks
migrations 001 to 014 as already applied **without running any of their SQL**. For each one it checks that the objects the
migration creates (tables, columns, indexes, views) are really in the database, and it only marks a clean run from the start:
if anything is missing or half-there it marks nothing and tells you what. Migrations 015 and later then run normally.

**Before you start:** make sure a backup exists and has been checked (section 3).

**Option A: let the deploy do it (no shell needed). Recommended.**
1. In Railway, `aa-crm`, Variables: add `MIGRATE_AUTO_BASELINE` = `true`.
2. Merge the pull request (or redeploy).
3. Open the deploy logs. You should see `MIGRATE_AUTO_BASELINE=true: baselining first.`, then `Marked as applied: 001_schema, ... 014_work_orders`, then `Applying 015_audit_log ...`, `Applying 016_rate_limits ...`, then the app starting.
4. If you see `Baseline refused: ...`, the deploy stops and the old version keeps running, and nothing was changed. Send the message to the developer.
5. Remove the `MIGRATE_AUTO_BASELINE` variable (it is only needed once; leaving it on is harmless but pointless).

**Option B: by hand, step by step.** The production database has no public address, so run these inside the service:
1. Merge and let it deploy (the app starts; the logs show the "has not been baselined" WARNING; it works but Settings, Users and the audit log will not until step 4).
2. Open a shell in the `aa-crm` service **[confirm in Railway]** (Railway CLI: `railway ssh` while linked to the project and the `aa-crm` service; or the service's shell if the dashboard offers one).
3. Look first. This changes nothing:
   ```bash
   npm run db:baseline
   ```
   Every line should say `present` for 001 to 014 and `absent` for 015 and 016, ending with "Would mark as already applied: 001_schema, ... 014_work_orders".
4. Record them, then migrate:
   ```bash
   npm run db:baseline -- --apply
   npm run db:migrate -- --dry-run     # should list exactly 015_audit_log and 016_rate_limits
   npm run db:migrate
   ```
5. Check: `npm run db:migrate -- --dry-run` now prints `No pending migrations.`

After either option, sign in as admin and open Settings, Users and Settings, Audit log to confirm they load.

### 2.3 Lockout recovery
If nobody can sign in (no active admin), set `FIRST_ADMIN_EMAIL` (and `FIRST_ADMIN_NAME`) on the `aa-crm` service and redeploy: with no active admin, the start command creates or re-activates that person as admin. It does nothing when an active admin exists. Remove the variables afterwards.

## 3. Backups

Data worth protecting: customers, jobs, signed contracts (PDFs are stored in the database), payments, commissions. A deploy cannot lose data, but a bad migration, a bad delete or a lost volume can.

### 3.1 Turn on and check Railway's backups  **[confirm in Railway]**
1. Railway, project `brilliant-surprise`, the **Postgres** service, **Backups** tab.
2. Enable scheduled backups: daily at least; add weekly and monthly if offered. Backups are a paid-plan feature and have their own retention limits, so read the retention shown on that tab.
3. Click **Backup now** once, before the first baseline/migration, and make sure it shows as complete with a size and a time.
4. Put a recurring calendar reminder (first Monday of each month): open the Backups tab and confirm the newest backup is less than 24 hours old and its size is not shrinking. A backup schedule that silently stopped is the usual failure.

### 3.2 Restore test (do once now, then every quarter)
A backup you have never restored is a guess. The point is to prove you can get the data back **without touching production**.
1. In the same Railway project, add a **new, empty Postgres service** (call it `restore-test`). Never restore over production for a test.
2. Restore the latest backup into it using Railway's restore option on the Backups tab, or if Railway only restores over the same service, take a `pg_dump` of production from a shell in the `aa-crm` service and load it:
   ```bash
   pg_dump --no-owner --format=custom "$DATABASE_URL" -f /tmp/aacrm.dump
   pg_restore --no-owner --dbname "$RESTORE_TEST_DATABASE_URL" /tmp/aacrm.dump
   ```
   (`RESTORE_TEST_DATABASE_URL` is the new service's connection string; delete `/tmp/aacrm.dump` afterwards, it contains customer data.)
3. Check it is the real thing, against `restore-test` only:
   ```bash
   psql "$RESTORE_TEST_DATABASE_URL" -c "select count(*) from users" -c "select count(*) from jobs" -c "select count(*) from payments" -c "select max(applied_at) from schema_migrations"
   DATABASE_URL="$RESTORE_TEST_DATABASE_URL" npm run db:migrate -- --dry-run     # expect: No pending migrations.
   ```
   The counts should match production (give or take what happened since the backup), and a signed contract PDF should be downloadable if you point a throwaway copy of the app at it.
4. Write down the date, how long it took, and anything that surprised you, then **delete the `restore-test` service** (it holds a copy of customer data).

### 3.3 Optional second copy
Railway's backups live inside Railway. For a copy somewhere else, run the `pg_dump` command above monthly and store the file in an encrypted place (it contains customer data and signed contracts). Not automated yet.

## 4. Environment variables (service `aa-crm` unless noted)

| Variable | Needed for | Notes |
|---|---|---|
| `DATABASE_URL` | everything | Reference the Postgres service's private address (`*.railway.internal`). |
| `APP_URL` | links in emails, redirects | The public address. Change with the domain. |
| `SESSION_SECRET` | sessions | Long random value. |
| `RESEND_API_KEY`, `EMAIL_FROM` | sign-in links, contracts, invoices, alerts | `EMAIL_FROM` must be on a domain verified in Resend, or only the Resend owner receives mail. |
| `ALERT_EMAILS` | failure alerts | Comma-separated. Set on the web service and on **each cron service**. |
| `FIRST_ADMIN_EMAIL`, `FIRST_ADMIN_NAME` | empty database or lockout only | See 2.3. |
| `MIGRATE_AUTO_BASELINE` | one deploy only | See 2.2 option A. |
| `INTEGRATION_KEY` | encrypting Hover tokens | 32 random bytes, base64. Losing it means reconnecting Hover. |
| `HOVER_CLIENT_ID`, `HOVER_CLIENT_SECRET`, `HOVER_REDIRECT_URI` | Hover | See SPEC decision log. |
| `COMPANYCAM_ACCESS_TOKEN` | CompanyCam | Expires every 90 days (next: Jan 3, 2027). An expired token now fails the cron run and emails `ALERT_EMAILS`. |
| `GOOGLE_MAPS_API_KEY` | Aerial roof estimate | Needs the Geocoding, Solar and Maps Static APIs enabled on the key; Google bills each call. Without it nothing is fetched. The feature also has its own switch in Settings, Aerial estimates (off by default). |
| `WEBSITE_FORM_SECRET` | website form endpoint | Shared secret header. |
| `PRUETT_FEED_URL`, `PRUETT_FEED_KEY`, `PRUETT_PRICE_LEVEL` | nightly price sync (Pruett cron service) and Settings, Product catalog, "Sync from Pruett now" (web service) | Key equals `PRICE_FEED_KEY` in Pruett POS. Level defaults to Builder. The older `PRUETT_POS_API_URL` / `PRUETT_POS_API_KEY` names still work when these are empty. |
| `QBO_*`, `DEMANDIQ_WEBHOOK_SECRET` | later slices | Not used yet. |

Never put a secret in the repository. `.env.example` lists names only.

## 5. Scheduled jobs and alerts

Each job is its own Railway **cron service** from this repository (same project). Create it once; it needs the variables
it uses (above), plus `DATABASE_URL`, `RESEND_API_KEY`, `EMAIL_FROM` and `ALERT_EMAILS`.

| Service | Start command | Suggested schedule (UTC) | Own variables |
|---|---|---|---|
| `cron-pruett` | `npm run cron:pruett` | `0 7,8 * * *` (07:00 and 08:00 UTC; the script runs only the one that is 2 am Central, so it is right in summer and winter) | `DATABASE_URL`, `PRUETT_FEED_URL`, `PRUETT_FEED_KEY`, `PRUETT_PRICE_LEVEL` (optional, default Builder), `ALERT_EMAILS`, `RESEND_API_KEY`, `EMAIL_FROM` |
| `cron-companycam` | `npm run cron:companycam` | `*/30 * * * *` | `COMPANYCAM_ACCESS_TOKEN` |

`scripts/run-cron.ts` runs the job and watches it. The run **fails** (non-zero exit, shown red in Railway) and **emails
`ALERT_EMAILS`** when the job exits non-zero, crashes, cannot start, or runs longer than 30 minutes. The email says which job,
why, and the last lines of output (tokens removed); the full output is in that service's logs. If `ALERT_EMAILS`,
`RESEND_API_KEY` or `EMAIL_FROM` is missing, the run still fails and the log has `cron.alert_not_sent`.

What counts as a failure for the CompanyCam job: a crash, or CompanyCam rejecting the access token. A single job that
CompanyCam cannot take right now is not a failure: it is retried automatically with growing waits (SPEC slice 9) and shows
on the job.

Other things to watch (set these up once):
- **Uptime:** an external monitor on `https://<your address>/api/health` (alerts when it is not 200).
- **Errors:** every unhandled server error is logged as one JSON line, `"event":"request.error"`, with method, route and error (never the query string or request body). In Railway's log search use `@level:error` or `request.error`. Cron failures log `cron.failed`; the sign-in limiter logs `rate_limit.store_failed` if its table is unavailable; migrations log `migrate.failed`.
- **Railway's own deploy-failed notifications:** Project settings, Notifications (email or Slack) **[confirm in Railway]**.

## 6. Security notes

- **Headers:** `next.config.ts` sets X-Frame-Options (SAMEORIGIN: the signing screen shows the contract PDF in a same-origin frame), X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS and COOP on every response. The Content-Security-Policy is set per request in `src/proxy.ts` because it carries a fresh nonce: only this site's scripts and Next's own nonce-carrying inline scripts run. Pages are therefore rendered per request (`force-dynamic` in the root layout). Styles allow inline (React `style=""`), and images allow any `https:` source because CompanyCam thumbnails come from hosts CompanyCam does not publish. If a browser console ever shows a CSP violation after a change, fix the cause rather than loosening the policy.
- **Who can call what:** `src/proxy.ts` only checks that a session cookie is present (cheap first gate). Every API route calls `requireRole(...)` and every page calls `getCurrentUser()`, and both look the session up in the database (hash, expiry, user still active). `tests/route-guards.test.ts` fails the build if an API route has no role check, and lists the five public routes, each with its own gate (`auth/request-link`, `auth/verify`, `auth/logout`, `leads/website`, `health`).
- **Sign-in throttling:** 5 requests per email and 20 per IP per 15 minutes, counted in Postgres (hashed keys), so deploys do not reset it. It fails open (and logs) if the table is unavailable so a limiter fault cannot lock everyone out.
- **Users:** turning someone off or changing their role ends their sessions at once. Everything is in Settings, Audit log.

## 7. Quick checks when something is wrong

| Symptom | Look at |
|---|---|
| Site down / deploy failed | Railway deploy log. `migrate.failed` means a migration rolled back. |
| "Features missing" after an old database | WARNING about baseline in the start log: run section 2.2. |
| Nobody can sign in | `FIRST_ADMIN_EMAIL` recovery (2.3); check Resend (`EMAIL_FROM` domain verified). |
| Photos not appearing on new jobs | `cron-companycam` last run; an alert email about the token. |
| Prices stale | `cron-pruett` last run and its alert email; Settings, Product catalog shows the last sync (warnings such as held price moves or a short feed show there). `npm run pruett:sync -- --dry-run` previews. |
