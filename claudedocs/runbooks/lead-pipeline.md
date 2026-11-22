# Runbook: lead pipeline (api/)

Support tier: **2, assisted triage** (agent diagnoses and proposes; a human approves anything that changes production data). No automated production writes are pre-approved.

## What it does
Public intake (`POST /api/leads`), call-tracking intake (`POST /api/staff/leads`), staff stage changes, consent opt-out, SLA sweep every 60 s, CRM outbox drain every 60 s. Postgres is the system of record for leads, stage history and consent.

## Failure modes, detection, first checks (all read-only)
| Symptom | Likely cause | Check |
|---|---|---|
| Leads not appearing | API down, DB down, 429 from rate limit | `GET /healthz`; API logs; `SELECT max(created_at) FROM leads` |
| Many `unrouted` leads | `routing_rules` empty or missing a ZIP | `SELECT routed_by, count(*) FROM leads GROUP BY 1`; `SELECT zip FROM routing_rules` |
| SLA breaches piling up | dispatch not working leads, or sweeper not running | `SELECT id, sla_due_at FROM leads WHERE sla_breached_at IS NOT NULL AND stage IN ('new','lead')`; look for "SLA breaches flagged" in logs |
| CRM missing records | webhook down, bad secret/URL, outbox stuck | `SELECT status, count(*), max(last_error) FROM crm_outbox GROUP BY 1` |
| Texts sent to someone who opted out | consent not checked by the sender | `SELECT * FROM consent_records WHERE contact_id = $1 ORDER BY id` (latest per channel wins). **Treat as an incident.** |
| Duplicate contacts | phone and email matched two people | `SELECT * FROM lead_events WHERE event_type = 'needs_review'` and merge by hand |
| 429 for real customers behind the proxy | `TRUST_PROXY` not set, all traffic shares one IP | check env; set `TRUST_PROXY=1` only when behind a reverse proxy |

## Proposed fixes (human approves)
- Re-drive failed CRM rows: `UPDATE crm_outbox SET status='pending', attempts=0, next_attempt_at=now() WHERE status='failed'` (CRM dedupes on `Idempotency-Key`).
- Add a routing rule: `INSERT INTO routing_rules (zip, service_line, branch_id, assignee_group) VALUES (...)`; existing unrouted leads need a manual reassignment.
- Never UPDATE or DELETE `lead_events` or `consent_records` (the database refuses). Corrections are new events.

## Incident response (tier 3)
Suspected PII exposure, wrong-person contact after opt-out, or leaked staff token: agent gathers evidence (queries above, log excerpts without PII) and drafts the report; a human rotates `STAFF_API_TOKEN` (shared mode) or disables the account and resets passwords (users mode: `node src/staff-cli.mjs disable <email>`, `set-password <email>`; both revoke sessions at once), notifies, and decides on disclosure.

## Known limits (not defects)
Per-user staff login exists (`STAFF_AUTH_MODE=users`: scrypt passwords, 12 h sessions, 60 min idle, 5-failure lockout, roles staff/approver/admin, `staff_auth_events` audit); shared-token mode remains the default until switched, and has no per-user identity. No MFA or SSO yet, no password reset by email (an admin or the CLI resets it); single outbox worker; calendar-minute SLAs; no bot challenge beyond honeypot and rate limit (Turnstile keys pending); email/SMS sending does not exist yet, so the opt-out rule is enforced in data, not yet in a sender.

## Chat agent (added with the wiring)
Start: set `LLM_PROVIDER=ollama`, `OLLAMA_MODEL`, `CORS_ORIGINS`; run `npm run catalog:sync` from a production site build; build the site with `PUBLIC_CHAT_API=<api url>`. Startup log says `chat agent enabled (model ...; N services, M ZIPs in catalog)` or `chat agent disabled`.
| Symptom | Likely cause | Check |
|---|---|---|
| Widget says "Chat is unavailable" | API down, CORS origin not listed, model server down or slow | `GET /healthz`; browser console CORS error; `curl $OLLAMA_URL/api/tags`; API log `llm_error` blocks in `agent_actions_log` |
| Every reply is the fixed fallback | model errors or timeouts, or the output guard blocks replies | `SELECT data FROM agent_actions_log WHERE event='blocked' ORDER BY id DESC LIMIT 20` (reasons only, no text) |
| Agent says "staff will confirm" to everything | catalog file missing or empty | `catalog` count in the startup log; re-run `catalog:sync` |
| Proposals never become leads | customer did not press Confirm, or proposal expired (15 min) | `SELECT status, count(*) FROM pending_actions GROUP BY 1` |
| Consent boxes missing in production | `src/data/consent.ts` wording is null (intended until approved) | owner supplies wording |
Never edit `agent_actions_log`, `lead_events` or `consent_records` (the database refuses). Chat transcript text is purged after `CHAT_RETENTION_DAYS`.

## Monthly measurement (added with Phase 5)
Needs `DATABASE_URL`. Commands: `cd api && npm run measure -- <command>` (details in the header of `api/src/measure/cli.mjs`).
1. Once, after the catalog is real: `panel-create --label "2026-12 v1" --catalog config/catalog.json` (40 queries, frozen; a new label for any change).
2. Each month and engine: `results-template --version N --month YYYY-MM --engine google_search > file.csv`. A person runs every query on that engine and fills `appeared`, `position`, `our_cited`, `cited_urls` (semicolon separated), and a required `evidence_ref` (screenshot name or saved answer). Then `import-results file.csv --version N --run-by "Name"`. A run completes automatically at 40 of 40 and then cannot be edited; a bad file is rejected whole with line numbers.
3. `import-gsc pages.csv --month YYYY-MM` (Search Console, Pages tab export, one month). `import-metrics gbp.csv --source gbp` (calls, direction requests, website clicks by branch). Re-importing a month overwrites it safely.
4. `spend --month YYYY-MM --channel google_ads --amount 1250.50` for each channel.
5. `report --month YYYY-MM --site-url https://your-site --out report.html --json report.json`. Read "Read this first" before the numbers. Do not commit real reports.
Troubleshooting: "unknown engine" or "query_id not in panel" means the template was edited or is from another panel version; "run already complete" means that month and engine is closed (record corrections in the next month's notes, not by editing); a report with "no data" cells means that source was not imported.

## Social publishing (added with the wiring)
Enable with `SOCIAL_ENABLED=1`. Startup log says which platforms can publish ("none" until adapters are registered in `api/src/social/registry.mjs`). Staff only: `/api/staff/social/*` with the bearer token.
| Symptom | Likely cause | Check |
|---|---|---|
| Publish returns 503 `publisher_not_configured` | no adapter registered for that platform (expected today) | startup log line; the post stays `approved` and can be published once an adapter exists |
| Publish returns 403 `no_consent` | no active consent for the platform, or it was revoked | `GET /api/staff/social/connections`; grant again with a named person |
| Submit returns 422 `content_policy` | fabricated review or customer voice, unapproved price or phone number, banned claim, secret-looking text, hidden characters | the response lists violation codes; fix the text |
| Approval refused | self-approval, non-person actor, or the post changed after approval | `GET /posts/:id/events` (audit trail; never edited) |
Never edit `social_post_events`; the database refuses. OAuth tokens must never be stored in these tables.
