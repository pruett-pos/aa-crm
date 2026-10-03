# A&A CRM — instructions for Claude Code

You are building A&A Exterior Group's in-house CRM, replacing Leap. Read
`docs/SPEC.md` before any feature work. The spec wins over your assumptions;
if the spec is silent or ambiguous, ask AL instead of guessing.

## Stack (do not change without asking)
- Next.js (App Router) + TypeScript, strict mode
- PostgreSQL on Railway (same Railway project as Pruett POS)
- Prisma ORM, with `db/schema.sql` as the reference design
- Auth: email magic link + role-based access (see Roles in SPEC)
- Hosting: Railway. Background jobs (nightly Pruett price sync, QBO sync) run as Railway cron services.
- Integrations go through `src/integrations/<name>/` and are never called directly from UI code.

## Business rules live in one place
All money math (commission, contingency fees, deposits, Pruett pricing,
margin) lives in `src/lib/rules.ts` and is covered by `tests/rules.test.ts`.
Never re-implement these calculations in components, SQL, or API routes —
import them. If a rule changes, change it there, update the test, and note
the change in `docs/SPEC.md` under "Decision log".

## Vocabulary (use these words in code, UI, and docs)
- "Scope of work" — never "bid" or "quote". The customer-facing document is a scope.
- "Estimator" — the sales rep. "Production Manager" (PM) — owns a division's installs.
- "Crew leader" — runs an install crew (sub or employee).
- Divisions: roofing, siding, gutters, windows_doors, insulation, spray_foam, commercial.
  (Solar is discontinued — do not build for it.)
- Job types: `retail` and `insurance`. Insurance customers are either
  `deductible_only` or `upgrade` (wants extras beyond the covered scope).
- Packages are Good / Better / Best.

## Working rules
1. One vertical slice at a time (DB → API → UI → test). Finish and commit before starting the next.
2. Use plan mode for every new feature; show the plan before writing code.
3. Every business rule gets a unit test. Every API route checks the user's role.
4. Never run migrations against production. Never commit secrets; use `.env` (see `.env.example`).
5. Ask before adding any new dependency.
6. UI copy is plain English, sentence case. Spanish is not needed; Russian
   labels are a future requirement for crew-facing screens — keep strings in
   `src/i18n/en.ts` so they can be translated.
7. Money is stored as integer cents. Percentages as basis points (10% = 1000).

## Brand
Heritage Navy #1F3A5F, Brass #D4A24C, Warm White #FAF7F0, Ink Black #1A1A1A.

## Commands
- `npm test` — business-rule tests (Node built-in test runner)
- `psql $DATABASE_URL -f db/schema.sql` — create schema on a fresh dev database
