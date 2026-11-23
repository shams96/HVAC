# 08 Request form and Google Calendar booking (spec phase)

Status: SPEC for review. No code written. Skills: spec-driven-development (this), later support-readiness and predeploy-security-audit.

## Problem
A visitor who checks their ZIP and is covered has no way to act: "Phone pending" and "Booking pending" are the only prompts. The site cannot produce a lead.

## Who and what "solved" looks like
A homeowner or building manager in the four counties can, in under a minute on a phone, either (a) request service by form and get a clear confirmation, or (b) pick a time on a calendar. Staff see the lead with its source, ZIP, and consent record. Nothing on the public page says "pending".

## In scope
1. **Request form** (name, phone, optional email, ZIP, service type, short description, consent checkbox). Posts to the existing `POST /api/leads` (source `form`), which already handles routing, SLA, consent records and a honeypot.
2. **Booking** via a Google Calendar appointment schedule link, opened from "Book service" buttons (source `booking` is recorded when the visitor clicks through, not when they book).
3. ZIP checker result gets a real next step: "Request service" (prefills ZIP) and "Book a time".
4. Hide "pending" labels on the public page once a value exists; until then the buttons that depend on it are not shown.

## Out of scope
Payments, deposits, SMS or email sending (not built; opt-out is enforced in data only), customer accounts, calendar sync back into the CRM, a Google Voice or any phone number purchase (owner action).

## Dependencies that are the owner's, not mine
| Item | Why it blocks | Who |
|---|---|---|
| Google Calendar appointment schedule URL | the booking link; I cannot create it in the owner's Google account | owner |
| Phone number (see note below) | call button and `tel:` link | owner |
| Consent wording for the form checkbox (`src/data/consent.ts` is null on purpose) | storing consent needs counsel-approved text; I will not draft binding legal text as final | owner and attorney |
| Where the API runs (Hostinger Node app + Postgres) | the form needs a live endpoint; today only a static site is deployed | owner approves, I set up |
| Legal company name | still required by the production build gate | owner |

## Decisions I am making (change any of them)
- Form posts to the existing API, not a new service. Reason: routing, SLA and consent logic already exist and are tested (292 API tests).
- Booking is a link to Google's hosted booking page, not an embedded widget. Reason: no third-party script on the page, no extra consent surface, faster load.
- Bot protection: honeypot and rate limit now; Cloudflare Turnstile when the owner creates keys.
- Until the API is live, the form is built and tested against fixtures but not shown on the public site (a form that discards leads is worse than no form).

## Acceptance
Form validates inline, errors say what to fix, double-submit is blocked, success text is calm and specific, 390px has no overflow, keyboard and screen reader work, Lighthouse accessibility stays 100, a lead posted from the form appears in the database with consent and source, and the audit and all tests pass.

## Honest gaps already known
No email or text confirmation to the customer (sender does not exist yet). Google appointment schedules are managed by the owner in Google Calendar, not by this repo.

## Converge (2026-11-22)
Built: `src/components/RequestForm.astro`, `src/pages/request.astro`, gated by `PUBLIC_LEADS_API`; booking buttons render only when `business.bookingUrl` exists; ZIP result offers "Request service" (gated) and "Book a time" (when a booking URL exists); "Phone pending" and "Booking pending" labels removed from header and mobile bar.
Verified this session: form posts to the real API (local, in-memory database): lead stored with channel `form`, source `website-form`, ZIP, service line, urgency; ticked SMS box stored as a granted consent with the wording version; empty submit shows inline errors and focuses the first bad field; 390px has no overflow; Lighthouse on /request/ accessibility 100, performance 100, CLS 0; API suite 298 passing (6 new), site tests 27 passing, audit passes.
Deviations from the spec: booking click-through is not recorded as a lead (the API needs a phone or email, which a link click does not provide); the build default keeps the request page but shows a "not open yet" note and `noindex` when no API is configured, rather than omitting the page.
Not verified: a real Google Calendar link (none supplied); a real browser against a production-hosted API; CORS origins for the real domain; email or text confirmations (do not exist). Consent checkboxes appear on staging with draft wording only; production shows none until wording is approved.
Remaining owner inputs: Google Calendar appointment schedule URL, phone number, consent wording, API hosting approval, legal company name.
