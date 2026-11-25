# 09 API hosting (plan phase)

Status: PLAN for approval. Nothing provisioned. Skills: spec-driven-development, deploy-readiness-checklist, predeploy-security-audit (before go-live), support-readiness (runbook update).

## Goal
`POST /api/leads` reachable over HTTPS from the public site, storing leads in Postgres, so `/request/` can go live.

## Facts (verified from the repo)
- API is Fastify on Node >=22.12, uses `pg` against **PostgreSQL** (no MySQL path), applies its own migrations at startup, runs a 60 s background tick (SLA sweep, CRM drain).
- Config is env only: `DATABASE_URL`, `STAFF_AUTH_MODE=users`, `CORS_ORIGINS` (exact origins), `TRUST_PROXY=1` behind a proxy, `PORT`, `HOST`. Chat and social stay off unless configured.
- First staff admin: `STAFF_NEW_PASSWORD=... node src/staff-cli.mjs create-user <email> admin "<name>"` (password is the owner's to set).

## Blockers found
1. **Hostinger tooling is not authorized in this session.** I cannot list sites, plans or databases until the owner authorizes the Hostinger connector (`/mcp`, then Hostinger). Claude cannot start that sign-in.
2. **Postgres on a Hostinger Business plan: unknown, probably unavailable (inferred, not checked).** Shared hosting databases are normally MySQL. The API cannot run on MySQL without a rewrite. To be confirmed once the connector is authorized.
3. **No production domain chosen.** The API needs an origin such as `api.<domain>`; CORS and `PUBLIC_LEADS_API` depend on it.
4. **Hostinger Node deploy overwrites the target website root.** It must target a dedicated subdomain site, never the one serving the public site.

## Verified 2026-11-23 via the Hostinger connector
- Account has one shared plan (order 201253397, user `u727712424`) hosting 11 sites; Node.js sites already run there. No HVAC site or domain exists on it.
- Hostinger database tools create **MySQL only**. Option C is ruled out; owner chose option A.
- Superseded by the 2026-11-24 rename: acrepairmasters.com is taken; .net, .org, .co and acrepairmastersdfw.com were available (not bought).

## Progress 2026-11-25 (staging API)
- Hostinger connector is authorized. GitHub app is installed for shams96 (active).
- Created an empty website on the existing plan with a free temporary subdomain: `zesty-plum-raccoon-39.hostingersite.com` (setup completed). No domain bought, no extra cost. It is staging only; production uses the chosen domain later.
- Not yet done: Postgres (needs the owner's Neon or Supabase account, connection string entered in the Hostinger env settings, never in chat), then env vars, then `hosting_deploy` of `shams96/HVAC` branch `main` with rootDirectory `api`, entryFile `src/main.mjs`, Node 22.

## Options
| | Where API runs | Where Postgres runs | Extra cost | Notes |
|---|---|---|---|---|
| A (recommended if Postgres is not on the plan) | Hostinger Node app on an `api.` subdomain (plan already paid) | Free-tier managed Postgres (Neon or Supabase), TLS, US region | $0 to start | Two vendors; lead data (PII) lives at the DB vendor, needs its terms reviewed |
| B | Hostinger VPS, API and Postgres together | same VPS | VPS monthly fee | One vendor, more ops work (patching, backups are ours) |
| C | Hostinger Node app and Hostinger Postgres | Hostinger | $0 | Only if the connector shows the plan offers Postgres |

## Steps once approved (option A or C)
1. Owner authorizes the Hostinger connector. I read plan, domains, existing sites and database support.
2. Owner picks the production domain (or accepts `api.` under the domain they own).
3. Provision database; capture `DATABASE_URL` through the platform, not chat.
4. Create the `api.` subdomain site; set env: `STAFF_AUTH_MODE=users`, `TRUST_PROXY=1`, `CORS_ORIGINS=<site origin>`, `HOST=0.0.0.0`, `PORT` per host.
5. Archive `api/` source only (no `node_modules`), deploy, poll the build, then verify `GET` health and a test `POST /api/leads` that I delete afterwards.
6. Run predeploy-security-audit against the live artifact, then rebuild the site with `PUBLIC_LEADS_API=https://api.<domain>` and redeploy.
7. Owner sets the first admin password locally; update the runbook (backups, where logs live, who gets paged).

## Out of scope here
Consent wording, Calendar link, phone number, email/text confirmations, Turnstile.

## Risks
Postgres test coverage was on PGlite, not a full server (noted in spec 03); run the suite against the real database once. Free-tier databases can pause or cap storage, which would drop leads: check limits before launch.
