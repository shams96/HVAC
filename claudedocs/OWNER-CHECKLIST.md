# Owner checklist: from staging to launch

Status as of 2026-11-24. Staging is live and noindex at https://hvac-site.hvac-site.workers.dev.
Every item is something only the owner can supply or decide. Mark done by replacing `[ ]` with `[x]` and committing.
Send A1 to A6 first; they unlock the real, indexable build.

## Known facts (from the owner)
- Owner and lead technician is EPA Section 608 certified. Certification type (Type I, II, III or Universal) not yet stated, so the site makes no certification claim until confirmed.
- Market: Dallas, Tarrant, Collin, Denton counties, Texas. Central time.
- Business name: AC Repair Masters (chosen 2026-11-24; code and brand files renamed, not yet deployed).

## 0. Name decision (blocks everything branded)
- [x] Final business name: AC Repair Masters.
- Check before deciding: Texas Secretary of State name search, USPTO trademark search, Google Maps for same-name competitors in DFW.
- Domain check 2026-11-24: acrepairmasters.com is TAKEN; .net, .org, .co and acrepairmastersdfw.com are available. Nothing purchased.
- Rename pass done (brandName, logo files, share image; favicon mark is unchanged). Domain purchase still needs your explicit yes.

## A. Blocks the production build
- [ ] A1. Legal name (for example "Name LLC"). Differs from the trading name.
- [ ] A2. Phone, display and E.164 forms (Google Voice number is yours to create).
- [ ] A3. Booking link (Google Calendar appointment schedule share link).
- [ ] A4. Street address, city, ZIP, or "do not publish address" if home based. Hours, and whether emergency service is 24/7.
- [ ] A5. Texas licence number(s) from TDLR (air conditioning and refrigeration contractor; inferred, confirm the type). EPA 608 is a federal refrigerant certification and is separate from the state licence. Insurance you can state.
- [ ] A6. EPA 608 certification type and whether you want it shown on the site.

## B. Content for real service and ZIP pages
- [ ] Service lines, residential and commercial.
- [ ] Approved price or range per service, or "free estimate"; services not offered.
- [ ] Confirm service area: four counties, the 206 derived ZIPs, branch location, travel bands.
- [ ] Real job photos, reviews you may show, one real local job per ZIP page (pages without real content stay unpublished).
- [ ] Brand and equipment partners you may name.
- [ ] Spanish version: yes or no.

## C. Going live
- [ ] Domain decision (after section 0), then explicit yes to purchase.
- [ ] Neon or Supabase Postgres account; connection string entered in Hostinger environment settings, never in chat.
- [ ] Node 22.23.4 or newer on the build machine (Astro 7 security fix).
- [ ] Cloudflare Turnstile keys (Turnstile is not wired into the code yet).

## D. Legal (needs an attorney)
- [ ] Consent wording, privacy policy, terms (current pages are drafts).
- [ ] Emergency wording: gas smell, carbon monoxide, no heat in freezing weather, no cooling in extreme heat.
- [ ] Texas items to confirm (inferred): TDPSA, TCPA for calls and texts, Texas telemarketing rules, TDLR advertising requirements (licence number on ads and site).

## E. Lead handling
- [ ] Who receives lead alerts and by what channel; an email service account (for example Resend) for sending.
- [ ] CRM or "none yet"; response-time target; what counts as a "job".
- [ ] Data retention periods (default: chats 30 days).

## F. Optional modules
- [ ] Chat agent: local model or hosted model with privacy review (shared Hostinger cannot run a local model). Stays off until decided.
- [ ] Social posting: platform, developer accounts, approvers. No platform adapters built yet.
- [ ] Search Console, Bing Webmaster, Google Business Profile access; someone to run the 40-query answer-engine check monthly.
- [ ] Training-bot stance: allow or block GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot (currently allowed by default); whether to add a Content-Signal line.

## Brief vs built (what is done)
- Done: site, DFW coverage checker, request form and one-field phone callback request (both off until API exists), lead API (298 tests), SEO layer (robots per bot, llms.txt, JSON-LD, sitemap lastmod, headers/CSP, OG image, verifier), staging deploy.
- Blocked on owner items: service and ZIP pages, FAQ and review schema, HVACBusiness data, form go-live, confirmations, Turnstile, API deployment, Astro 7, rename assets, real-phone test.
- Not promised: rankings or AI citations; llms.txt effect is unproven.

## Order
1. Section 0 and A1 to A6. 2. B. 3. C. 4. D before any public launch. 5. E, then F.
