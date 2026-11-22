# Phase 5: Measurement

Gate: first monthly query-panel run and dashboard. **Cannot be fully met yet:** there is no live site, no Search Console or GBP access, and no real ZIP or service list. This phase builds the whole system and proves it on a labelled fixture dry run; the first real run is data entry, not engineering.

## Spec (what/why)
Know, per ZIP and service line, whether the business shows up and gets cited in search and AI answers, whether that turns into calls, leads and booked jobs, and what a booked job costs. **No single visibility score** (the brief forbids it): results are shown as what appeared, where, and which sources were cited.

Out of scope: automated scraping of search or AI answer pages (terms and the brief's "official sources only" rule), Search Console / GBP API OAuth (CSV import instead; API connectors later), call-tracking vendor integration, live staff-login dashboard (a generated report file instead).

## Decisions
1. **Fixed panel of 40 queries**, generated deterministically from the approved catalog (ZIPs x service lines x intents: local, price, urgent, trust, commercial), balanced across ZIPs and services. A panel version is **frozen on creation** (database rejects changes); changing queries means a new version, so month to month stays comparable.
2. **Runs are recorded, not scraped.** Per engine per month a person (or an official API) records for each query: did we appear, at what position, were we cited, which URLs and domains were cited, and an evidence reference (screenshot or saved answer). Engines: google_search, google_ai_overview, bing_search, bing_copilot, chatgpt_search, perplexity, gemini. A completed run is immutable (trigger). Inserts must match the run's panel version.
3. **Search Console has no ZIP field**, so impressions and clicks by ZIP come from the ZIP landing page URL (`/service-area/{city}-{zip}/`). Imported from the GSC "Pages" CSV export, one calendar month at a time, idempotent upsert. Non-ZIP pages are kept as page-level metrics.
4. **GBP actions** (calls, direction requests, website clicks) and any other source come in through a generic metrics CSV with a per-source metric allowlist. Calendar-month granularity.
5. **Funnel from our own database** (cohort by lead creation month): leads by channel and ZIP, `unrouted` count (data quality), jobs = leads that reached `booked` or `won`, lead-to-job rate = jobs / leads, cost per booked job = ad spend of the month / jobs. A rate or cost with no denominator is `null` (shown as "no data"), never 0.
6. **Output:** JSON plus a self-contained HTML report (no external requests, all text escaped, "FIXTURE DATA" banner when built from fixtures). Aggregates only, no personal data.

## Tasks
1. Migration `005_measurement.sql`, panel generator, tests.
2. Importers: panel results, GSC pages, generic metrics, ad spend.
3. Report builder and HTML renderer.
4. CLI, fixture dry run, review the report.
5. Docs, runbook, monthly checklist.

## Monthly procedure (once real data exists)
Day 1: freeze nothing new; export the results template for the month. Days 1 to 5: a person runs each query on each engine and fills the template (or an official API does). Import results; import GSC Pages CSV and GBP metrics; enter ad spend; run the report; owner reviews. Keep evidence references.

## Open items for owner
Real ZIPs, services and priced/free status (to generate the real panel); Search Console and GBP access (exports to start); who runs the monthly panel; which engines matter; ad spend source; call tracking vendor; what counts as a "job" if different from booked or won.

## Converge (2026-11-21)
Built (all under `api/src/measure/`): CSV layer (quote-aware, line-numbered errors, spreadsheet formula protection on export), panel generator and frozen versions, importers (panel results, Search Console Pages export, generic monthly metrics, ad spend in integer cents), report builder, self-contained HTML renderer, CLI (`npm run measure -- <command>`), migration `005_measurement.sql`, fixture dry run (`api/scripts/measure-dryrun.mjs`).
Verified: 266 API tests (24 new for measurement) plus 20 site tests, all passing. Database rules tested directly: panel versions and queries cannot change; a completed run and its results are immutable; a result cannot reference a query from another panel version, even by raw SQL. Importers are all-or-nothing with line numbers. Report arithmetic checked against independently computed expectations (appearance and cited counts, gained/lost vs last month, cohort-by-creation-month funnel, jobs, spend, cost per job). "No data" is null, never zero (empty month; spend with no jobs). No key anywhere in the report matches score, visibility, overall or grade. HTML: all values escaped (a hostile page name stays text), no scripts, no external requests. Mutation checks: null-rate rule, zero-cost rule and escaping each make a test fail. CLI run through the real `pg` client against a wire-protocol database: refuses an empty catalog, builds the panel, template, import, duplicate-import refusal, spend, report. The dry-run report was opened in the browser pane.
NOT done, because it cannot be done yet: a real first monthly run and a real dashboard of real numbers. There is no live site, no Search Console or GBP access, no real ZIPs or services. The only report is the fixture dry run (`claudedocs/reports/measure-fixture-dryrun.html`), labelled FIXTURE DATA in the file and in the report; every number in it is invented.
Known limits: panel results rely on a person recording honestly (evidence reference is required, not verified); AI answers vary by location, time and personalization, so a single manual run is a signal, not proof; ZIP figures from Search Console come from the ZIP page URL and miss searches that landed elsewhere; calls count only call-channel leads until call tracking is connected; the dashboard is a generated file, not a live staff-login page (needs per-user auth); cohort jobs for the latest month keep rising as leads progress, so re-run a month's report later to see it settle; no automated collection (official API connectors for Search Console and GBP are a later step).
Judgement call to confirm: "job" = a lead that reached booked or won. If the owner counts jobs differently (completed, invoiced), change the SQL in `report.mjs` and the definition in the report text.
