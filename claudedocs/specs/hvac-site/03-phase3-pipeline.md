# Phase 3: Lead pipeline (B2C + B2B)

Gate: end-to-end test with sample leads. Owner decision: build now, revisit blockers after.

## Spec (what/why)
Every call, form, chat and booking lead (residential) and every commercial/property-management lead becomes one auditable record that is deduped, routed by ZIP and service line, timed against an SLA, and synced to the CRM. Solved when a test run of sample leads shows: dedupe by phone/email, correct routing (including unrouted fallback), SLA breach detection, B2B stage progression, consent honored (opt-out immediate), every stage change recorded with who/what triggered it, and CRM outbox delivery with retry.

Out of scope: chat agent (Phase 4), outbound messaging, GBP/social, real CRM credentials, UI for staff, call-tracking vendor integration, hosting.

## Decisions (stated, change on owner say-so)
1. **System of record:** PostgreSQL in this project owns lead intake, stage history and consent. The CRM is a downstream copy fed by an outbox webhook. *Owner confirms which CRM (blocking input #5); if the CRM must own customers, only the sync adapter changes.*
2. **Postgres access** through a tiny adapter (`query`, `transaction`): `pg` Pool in production, PGlite (real Postgres in WASM) in tests. Same SQL both places.
3. **No Redis yet.** SLA timers are `sla_due_at` columns plus a sweep function (`sweepSlaBreaches`); BullMQ/Redis is added only if volume needs it (YAGNI). The brief lists Redis for queues; this defers it, not drops it.
4. **Dedupe:** contacts matched on E.164 phone (US only, per brief's ZIP assumption) or lowercased email. If phone and email match two different contacts, do not merge: log a `needs_review` event. A new inquiry from a contact with an open lead for the same service line within 14 days attaches to that lead as an event, not a new lead.
5. **Routing:** exact (zip, service_line) rule, then (zip, any), else `unrouted` queue for human triage. The rules table is empty until the owner supplies ZIPs and branches. Nothing is invented.
6. **SLA (calendar minutes, defaults, owner to confirm):** emergency 15, call 15, booking 60, chat 30, form 60; B2B 240. Business-hours-aware SLA waits on owner hours (blocking input #1).
7. **Stages:** B2C `new > contacted > booked > won | lost`. B2B `lead > site_visit > quote > negotiation > won | lost`. Transitions are validated; `lost` needs a reason; every transition writes an append-only `lead_events` row (DB trigger blocks UPDATE/DELETE) with actor type (user, system, agent, webhook) and actor id.
8. **Consent:** append-only `consent_records` per contact and channel (call, sms, email, marketing) with the exact wording version shown. Latest row wins; `revoked` blocks that channel immediately. Forms never pre-check boxes. Legal rules per channel/state (TCPA, CAN-SPAM, state laws) need **attorney review before launch**; this is engineering, not legal advice.
9. **Auth:** public intake and opt-out are open but rate-limited with a honeypot field (Turnstile keys come from the owner later). Staff endpoints use one bearer token from env (timing-safe compare) and a required `actor` label. **Per-user staff auth is an open item**, not done here.
10. **PII:** minimal fields only; request logs redact phone/email/name; encryption at rest and TLS are infrastructure settings (managed Postgres) and are **not** verifiable from this code.
11. **Retention (proposed, owner confirms):** lost/no-consent leads anonymized after 24 months; consent records kept 5 years (proof of consent). Implemented as `anonymizeExpired()`; no scheduler yet.

## Open items for owner
CRM choice and webhook URL/secret; business hours for SLA; confirm SLA minutes; retention periods; consent wording; call-tracking vendor; staff identity provider.

## Tasks
1. api package + deps, audit.
2. Pure domain modules (phone, routing, sla, stages, consent) + unit tests.
3. Schema + repository (intake, transition, opt-out, sweeps, B2B accounts/sites/agreements, anonymize) verified on PGlite.
4. Fastify server, CRM outbox worker (HMAC-signed webhook, retry/backoff).
5. End-to-end test with sample leads.
6. Runbook (support-readiness), converge, revisit blockers.

## Converge (2026-11-21)
Built under `api/`: domain modules, `schema.sql`, repository, Fastify server, CRM outbox worker, `main.mjs`, runbook (`claudedocs/runbooks/lead-pipeline.md`).
Verified: **30 api tests pass** (plus the 20 site tests), including the gate's end-to-end sample-lead run (intake, cross-format dedupe, ZIP routing, unrouted fallback, emergency SLA, sweep idempotency, B2C and B2B stage walks with actors, skipped-stage refusal, opt-out flips consent, ordered audit trail, signed CRM delivery exactly once). Database-level guards tested: append-only audit and consent (UPDATE/DELETE rejected), stage vocabulary per type, lost needs a reason. Mutation check: deliberately breaking the SLA sweep and the dedupe rule made tests fail, then restored. Production `pg` adapter verified over the Postgres wire protocol, and the real `main.mjs` process booted, migrated, served intake and enforced staff auth. `npm audit`: 0 vulnerabilities.
Caveat: the database under test is PGlite (real Postgres engine compiled to WASM), not a full Postgres server; one-connection limit means pool concurrency, locking under load and `FOR UPDATE` contention are **not** exercised. Run the suite once against a real Postgres before launch.
Fixed during build: ids differed in type between endpoints over `pg` (now numbers), rate limiting ignored real client IP behind a proxy (`TRUST_PROXY`).
Not verified or not built: real CRM, real hosting, TLS and encryption at rest (infrastructure), per-user staff auth, Turnstile, CORS, outbound messaging, scheduled retention job (function exists, no scheduler), consent-record retention, business-hours SLA, load behavior. Consent and messaging law need attorney review.
Gate status: the end-to-end sample-lead test passes. Formal sign-off is the owner's, and the open items above (CRM choice, hours, retention, wording) still need their answers.
