# A&A CRM

In-house CRM replacing Leap for A&A Exterior Group.

## What's here (sprint 1)
- `CLAUDE.md` — standing instructions Claude Code reads every session
- `docs/SPEC.md` — product spec, incl. open questions for AL
- `db/schema.sql` — Postgres schema (validated on Postgres 16), `db/seed.sql` — fake dev data
- `src/lib/rules.ts` — every money rule (commission, contingency, deposit, Pruett pricing, call routing, pipeline)
- `tests/rules.test.ts` — 9 passing tests (`npm test`, Node 22.18+)
- `prototype/index.html` — clickable pipeline + job detail mockup

## Next sprint (paste into Claude Code, plan mode)
> Read CLAUDE.md and docs/SPEC.md. Scaffold the Next.js app in this repo with
> Prisma generated from db/schema.sql, deploy target Railway. Build slice 1:
> login with roles, customers + properties, and the jobs pipeline board using
> prototype/index.html as the visual reference. Import rules from src/lib/rules.ts.
> Show me the plan first.
