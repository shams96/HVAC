# Owner checklist: from tested to launchable

Status as of 2026-11-22. Staging site is live and noindex at https://hvac-site.hvac-site.workers.dev.
Every item below is something only the owner can supply or decide. Each says where it goes and what it unblocks.
Mark an item done by replacing `[ ]` with `[x]` and committing.

## A. Blocks the production site build (do these first)

The production build refuses to emit until the first four exist (`src/data/business.ts`).

- [ ] Legal business name
- [ ] Phone, display and E.164 form (for example `(555) 010-0100` and `+15555550100`)
- [ ] Booking URL (a real page or scheduler link)
- [ ] Street address, city, ZIP (the public NAP; also feeds schema and Google Business Profile). State is already set to TX and region to "the Dallas and Fort Worth area" from your 2026-11-22 message; which city is the branch?
- [ ] Texas air conditioning and refrigeration contractor licence number(s) (issued by the Texas Department of Licensing and Regulation, TDLR; inferred, please confirm the exact licence type and that it must appear on the site and ads), plus any local city registrations
- [ ] Business hours (Central time is already set), including whether emergency service is 24/7
- [ ] Country confirmed (US, now implied by Texas)
- [ ] Logo and favicon files (SVG preferred)

## B. Service catalog (blocks content pages and the chat agent)

- [ ] Service area: which DFW cities and counties you serve (for example Dallas, Tarrant, Collin, Denton), then I build the ZIP list from an official source and you confirm it, grouped into travel bands (core, extended, by request). Branch location decides the bands.
- [ ] Spanish: do you want a Spanish version or Spanish chat replies? (Large share of DFW customers; this is a decision, not assumed.)
- [ ] Service lines, residential and commercial (install, repair, maintenance, emergency, and so on)
- [ ] Approved prices or price ranges per service, or an explicit "no public prices" decision (nothing is quoted without approval)
- [ ] Which services are not offered, so the agent can decline them
- [ ] Brand and equipment partners you may name (only ones you are authorised to name)
- [ ] Real photos, team names, and customer reviews you have permission to show (none are fabricated; empty is acceptable at launch)
- [ ] Fleet colors, only if you want design Option B

## C. Domain and hosting

- [ ] Domain name decision (a new domain, or an existing one)
- [ ] Who controls its DNS (Cloudflare can host the DNS; the registrar can stay where it is)
- [ ] Node 22.23.4 or newer installed on the build machine (needed for Astro 7.4.13, which fixes the advisories on the current 6.4.8). Required before first ship.
- [ ] Production API host with Postgres (the static site cannot take leads alone). Decision: where does it run?

## D. Lead pipeline (Phase 3)

- [ ] CRM choice, and the webhook URL and secret (or "none yet": leads then live only in the API database)
- [ ] Business hours for the response clock, and the response-time target in minutes
- [ ] Data retention periods for leads and chat transcripts (defaults: chats 30 days)
- [ ] Who receives lead alerts, and by what channel
- [ ] Call-tracking vendor, or "none"
- [ ] Cloudflare Turnstile site key and secret (free; create in the Cloudflare dashboard)
- [ ] Confirm what counts as a "job": booked, or won

## E. Consent and legal (needs an attorney)

- [ ] Approved consent wording in `src/data/consent.ts` (SMS, call, email, marketing scopes)
- [ ] Approved privacy policy and terms text (the current pages are drafts, not legal advice)
- [ ] Attorney review of chat-agent disclosures and any AI-generated-answer disclaimer
- [ ] Decision on double opt-in for chat consent (recommended; prevents consent being given for someone else's number)
- [ ] Approved emergency wording (gas smell, carbon monoxide, no heat in freezing weather, and no cooling during extreme summer heat, which matters in Texas for elderly or medically vulnerable residents)
- [ ] Texas items for the attorney to confirm (inferred, not verified here): Texas Data Privacy and Security Act (TDPSA) applicability, federal TCPA rules for SMS and calls, Texas telemarketing registration rules if you do outbound calls or texts, and any TDLR advertising requirements

## F. Chat agent (Phase 4)

- [ ] LLM choice. Local Ollama keeps customer data on your server; a hosted model needs a privacy review. Machine must be able to run a tool-calling model.
- [ ] Availability system (calendar or dispatch tool) for real appointment slots, or "request a callback only"
- [ ] Approval of the demand-source shortlist and the crawler policy for AI-training bots (currently allowed by default)

## G. Staff access

- [ ] Staff identity provider (Google Workspace, Microsoft, or other) so each person has their own login
- [ ] Names of the people who may approve social posts, and whether a second approver is required
- [x] Per-user staff login is built (`STAFF_AUTH_MODE=users`). Remaining for you: create the first admin on the server, set `STAFF_AUTH_MODE=users` in production, and decide whether to add SSO or MFA later
- [ ] Roles: who is staff, who is approver, who is admin

## H. Social publishing (stays off until adapters exist)

- [ ] Which platform first (Google Business Profile, Facebook, Instagram, YouTube)
- [ ] Developer accounts and OAuth app registration per platform, plus platform review
- [ ] Which consent scopes count as permission to post

## I. Measurement (Phase 5)

- [ ] Google Search Console access, and Google Business Profile access (exports of Pages and performance data)
- [ ] A person to run the 40-query answer-engine panel by hand each month (no scraping)
- [ ] Monthly ad spend figures, if running ads

## Suggested order

1. A and B unlock a real build and the first content.
2. C gives the site its address and a place for the API.
3. D and E make lead capture legal and usable; do not turn on forms before E.
4. F, G, H, I follow, in that order. F and G can start after D.

## What I will do once each group lands

- A, B: fill `business.ts` and the catalog, run the production build, run the audit, deploy.
- C: move to Astro 7, connect the domain, set the site URL (fixes the sitemap line in `robots.txt`), deploy the API.
- D, E: wire CRM, Turnstile, retention and consent text; re-run security audit.
- F to I: configure the model, build staff login, build platform adapters, run the first real measurement.
