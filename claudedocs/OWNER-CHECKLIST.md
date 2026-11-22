# Owner checklist: from tested to launchable

Status as of 2026-11-22. Staging site is live and noindex at https://hvac-site.hvac-site.workers.dev.
Every item below is something only the owner can supply or decide. Each says where it goes and what it unblocks.
Mark an item done by replacing `[ ]` with `[x]` and committing.

## A. Blocks the production site build (do these first)

The production build refuses to emit until the first four exist (`src/data/business.ts`).

- [ ] Legal business name
- [ ] Phone, display and E.164 form (for example `(555) 010-0100` and `+15555550100`)
- [ ] Booking URL (a real page or scheduler link)
- [ ] Street address, city, state, ZIP (the public NAP; also feeds schema and Google Business Profile)
- [ ] State licence number(s), and contractor licence number if separate
- [ ] Business hours, including whether emergency service is 24/7
- [ ] Country confirmed (assumed US)
- [ ] Logo and favicon files (SVG preferred)

## B. Service catalog (blocks content pages and the chat agent)

- [ ] Service area: every ZIP you serve, grouped into travel bands (core, extended, by request)
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
- [ ] Approved emergency wording (gas smell, carbon monoxide, no heat in freezing weather)

## F. Chat agent (Phase 4)

- [ ] LLM choice. Local Ollama keeps customer data on your server; a hosted model needs a privacy review. Machine must be able to run a tool-calling model.
- [ ] Availability system (calendar or dispatch tool) for real appointment slots, or "request a callback only"
- [ ] Approval of the demand-source shortlist and the crawler policy for AI-training bots (currently allowed by default)

## G. Staff access

- [ ] Staff identity provider (Google Workspace, Microsoft, or other) so each person has their own login
- [ ] Names of the people who may approve social posts, and whether a second approver is required
- [ ] Build item for me: per-user staff login (the shared staff token cannot enforce two-person approval)

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
