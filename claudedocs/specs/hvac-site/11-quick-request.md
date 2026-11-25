# 11 Phone-only quick request and triage selections

Status: built 2026-11-24. Skills: spec-driven-development (compressed: spec, build, converge), local-service-lead-engine rules.

## Problem
The request form asks for name, ZIP and service as required fields. A stressed visitor (no cooling in July) may leave rather than fill four fields.

## Solved means
A visitor can leave a callback request with one field (phone number) and one tap, on a phone, and staff see a real lead flagged as a quick request.

## In scope
1. `QuickRequest.astro`: "What is happening?" (required selection) and phone number (required), button "Request callback". Honeypot has no visible text, inline errors, no alert(), 44px targets.
1a. **Triage** (`src/lib/triage.mjs`, `TriageFields.astro`, shared with the full form, which no longer has an urgent checkbox or a service select): 16 exact choices in 4 groups (checked against published practice 2026-11-24: added ice on coil, blank thermostat, tripping breaker; gas alert no longer tells the person to touch switches; CO alert adds stay outside until cleared). Safety choices (gas smell, carbon monoxide alarm, smoke/burning/sparks) show an immediate call-911 alert. "No cooling" and "No heating" are always urgent (owner decision 2026-11-25) and still ask the two risk questions so staff see the answers. The questions (vulnerable person; dangerous indoor temperature, thresholds 90F and 50F in code). Levels sent to staff in `details.triage`: safety, urgent, soon, routine; `emergency` is true for safety and urgent. A level is a staff priority, not a promise of a response time.
2. Rendered at the top of `/request/`, above the full form, only when `PUBLIC_LEADS_API` is set (same gate as the form).
3. Posts to the existing `POST /api/leads`: `channel: "form"`, `source: "website-quick"`, `serviceLine` derived from the selection (cooling, heating or other), `type: "B2C"`, `details.quick: true`. The API already accepts a lead with only a phone (name and ZIP are optional there); no API change.
4. Shared pure logic in `src/lib/quick-request.mjs` (phone validation, payload) so it is unit tested.

## Out of scope
Home-page placement (the hero's one action stays the ZIP check; the sticky Request bar already leads here). Commercial requests (use the full form). Text or email confirmation (no sender exists). Turnstile (owner keys). Recording consent: a callback to the number the person gave is not marketing consent, so no consent record is written.

## Decisions
- Routing: no ZIP means unrouted, so human triage. Staff collect name and ZIP on the call.
- DRAFT RULES pending owner and attorney: the symptom list, risk questions, temperature thresholds and alert wording. Change them in `triage.mjs` only.
- Labels are short on purpose: native pickers cut long labels on a 375px phone (checked).
- Dedupe: if the same phone later submits the full form, it attaches to the open lead instead of duplicating.
- Copy is DRAFT pending owner and attorney review, like the rest of the site.

## Honest limits
- The form is still off on the public site until the API is deployed (owner items: Postgres account, domain/CORS).
- A phone-only lead has no ZIP, so it is not checked against coverage until staff ask.
- No spam beyond honeypot and the API rate limit (10 per minute per connection) until Turnstile is wired.
