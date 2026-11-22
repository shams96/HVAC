# Phase 0: Research Spike and Design Gate

Date: 2026-11-21. Status: **awaiting owner sign-off**. Nothing from Phase 1 has been started.

Evidence tags: **verified** = measured or seen this session. **inferred** = from general knowledge, not checked against current terms. **unknown** = not checked.

## 0. Blocking inputs (owner-supplied; none exist in the repo or brief)

| # | Item | Why it blocks |
|---|------|---------------|
| 1 | Legal business name, NAP (name, address, phone), licence numbers | Schema, GBP and every page must match exactly |
| 2 | Branch list and service ZIPs/cities, with travel-time bands | Service-area table, ZIP pages |
| 3 | Service lines (repair, install, heat pump, IAQ, maintenance plans, commercial) and which have approved prices vs "free estimate" | Service pages and Offer markup |
| 4 | Fleet wrap and uniform colors (hex or photo) | Decides Option A vs B |
| 5 | CRM already in use (system of record) | Pipeline design |
| 6 | Country/states of operation | Consent rules (TCPA, CAN-SPAM, state mini-TCPA, CASL if Canada). Assumed **US** because the brief says "ZIP". |
| 7 | Existing GBP, Search Console and analytics access | Baseline data, real demand signal |

## 1. Finding that changes the brief: the accent rule is unsatisfiable as written

The brief requires the accent to pass 4.5:1 text contrast "against both the neutral background and the primary."

- **Verified:** primary #186767 vs background #fef9f3 is 6.32:1. Because the background is near-white and the primary is mid-dark, a color that clears 4.5:1 against both would have to be darker than ~0.17 relative luminance (vs the background) and lighter than ~0.63 (vs the primary). Those ranges do not overlap.
- **Verified:** a brute-force scan of the RGB space (step 5) finds a best achievable min-contrast of **3.17:1** (pure black). No color meets 4.5:1 against both.

**Proposed reinterpretation (needs owner sign-off):** WCAG measures different things for different roles.
- Accent button *fill* vs the surface it sits on: ≥3:1 (WCAG 1.4.11, non-text).
- Button *label* vs the accent fill: ≥4.5:1 (WCAG 1.4.3).
- Accent *as text* is allowed only on the neutral background, at ≥4.5:1.
- On teal panels the accent button gets a 2px neutral (#fef9f3) ring (6.32:1 against teal) so the button edge stays distinct.

## 2. Design direction (gate deliverable)

**Recommendation: Option A, Modern and Eco-Focused.** Option B cannot be evaluated until item 4 above is supplied. Any mismatch with the fleet colors is a gate issue.

### Palette (named tokens, defined once in `tokens.css`)

| Token | Hex | Role | Share |
|-------|-----|------|-------|
| `--color-surface` | #fef9f3 | page background (warm off-white) | 60% |
| `--color-surface-raised` | #ffffff | data-heavy panels, forms | within the 60% |
| `--color-primary` | #186767 | brand teal: header, section bands, links, map | 30% |
| `--color-ink` | #0b2a2a | body text (teal-tinted near-black) | text |
| `--color-ink-muted` | #4a6363 | secondary text | text |
| `--color-accent` | **#a31d4b** (berry) | buttons and phone/booking prompts only | 10% |
| `--color-on-accent` | #ffffff | button label | text |
| `--color-focus` | #0b2a2a | focus ring (2px, 2px offset) | UI |

Berry avoids the brief's "no terracotta or orange" default. It also reads as distinct from teal for color-blind users, since it differs strongly in luminance from teal on the neutral surface.

### Contrast ratios (verified, computed from WCAG 2.x relative luminance)

| Pair | Ratio | Requirement | Pass |
|------|-------|-------------|------|
| ink on surface | 14.55 | 4.5 text | yes |
| ink-muted on surface | 6.16 | 4.5 text | yes |
| primary (text/links) on surface | 6.32 | 4.5 text | yes |
| surface on primary (header/bands) | 6.32 | 4.5 text | yes |
| white label on accent | 7.41 | 4.5 text | yes |
| accent fill vs surface | 7.08 | 3.0 non-text | yes |
| accent fill vs white panel | 7.41 | 3.0 non-text | yes |
| accent fill vs primary | 1.12 | 3.0 non-text | **no, by design: use surface ring** |
| surface ring vs primary | 6.32 | 3.0 non-text | yes |
| focus ring vs surface | 14.55 | 3.0 non-text | yes |

Not yet tested: the accent under hover/pressed states, and any imagery overlay text. These are Phase 1 audit items.

### Typefaces and roles
- Body and navigation: **Inter** (SIL OFL, self-hosted, variable). Nav links 14px. **Inferred** licence; confirm at download.
- Headlines (large only): optional serif, **Fraunces** (SIL OFL). If Inter alone looks generic at the layout gate, add it; otherwise skip to save a font request (LCP).

### Layout concept
- Header on every screen: logo left, phone number (accent, click-to-call) and "Book service" (accent) right. On mobile these collapse to a sticky bottom bar.
- Home: direct-answer hero ("who we are, where we serve, how fast"), a ZIP entry field above the fold (geolocation is opt-in and only pre-fills it), then services and local proof. The single orchestrated motion is the hero reveal.
- **Memorable element per template:** home = service-area map with ZIP coverage and travel-time bands (static SVG rendered server-side, progressively enhanced). Service page = typical-scope-and-price-drivers panel. ZIP page = the local job log and permit/climate note.
- Quiet everything else: flat bands, 1px rules, no card grids of identical rounded boxes, no gradients, no all-caps eyebrows, no arrows on every link, no 01/02/03 markers unless the content is a true sequence.

### Principles
1. Answer first, then detail. 2. One accent, one job (act now). 3. Every page works at 360px and without JavaScript. 4. Motion only on user action, except the hero reveal. 5. Real photos and real jobs, not stock.

## 3. Demand-source report (per ZIP)

All terms below are **inferred** from general knowledge and must be re-verified against current terms before any collection code is written. None was fetched this session.

| Source | Gives | Access | Licence/terms (inferred) | Refresh | Known gaps |
|--------|-------|--------|--------------------------|---------|------------|
| Own call tracking and CRM | calls, bookings, jobs by ZIP, service line, cost | owner systems | owned data; consent needed for call recording | real time | zero history on a new site |
| Search Console API | impressions, clicks by query and page | OAuth, own property | free, own data | ~2 day lag | own queries only; no ZIP field, so ZIP is inferred from landing page |
| GBP Performance API | calls, direction requests, searches per profile | OAuth, own profile | free, own data | daily | no per-ZIP split |
| Google Ads Keyword Planner | search volume ranges by geo | needs an Ads account | usage tied to Ads terms; ranges unless spending | monthly | coarse; metro-level more reliable than ZIP |
| NWS API (api.weather.gov) | forecasts, heat/cold alerts | public API, User-Agent header | US government, free | minutes | not climatology |
| NOAA NCEI Climate Data | degree days, normals, station history | public API/CDO | US government, free | daily to monthly | station-to-ZIP mapping needed |
| US Census ACS (ZCTA) | housing age, heating fuel, tenure, income | public API, key | public domain | annual | ZCTA is not identical to a ZIP |
| Municipal permit portals (Socrata/CKAN/ArcGIS) | mechanical/HVAC permits by address | open-data APIs | varies per jurisdiction; read each portal's licence | daily to monthly | uneven coverage; some cities have no open data |
| Google Trends | relative interest by region | no stable official API (**unknown**; check) | scraping is not allowed under terms | n/a | relative only |
| Public review pages (Google, Yelp, forums) | sentiment themes | official APIs only | caching and bulk analysis generally restricted; display needs attribution | n/a | likely **not** usable for bulk theme mining; owner's own GBP reviews are fine |

**Excluded:** scraping any source; any source whose terms forbid storage or derived analysis; generating or seeding reviews.

**Recommended build order for scoring:** own data first, then weather degree days plus ACS housing age (cheap, legal, explainable), then permits per city where an open feed exists. The demand score shows its inputs (each value, source, timestamp). No single black-box number.

## 4. Service-area model (schema only; rows are owner-supplied)

`service_area(zip, city, state, branch_id, status{active|planned|excluded}, travel_band{0-15|15-30|30-45 min}, service_lines[], page_slug, last_verified_at)`

- Each `active` row gets one canonical page `/service-area/{city}-{zip}/`. No duplicate ZIP pages. A ZIP with no unique content stays `planned` and gets no page.
- Unique-content gate per page: at least one owner-approved local job and one verifiable local fact (climate/permit/utility rule) with a source link.

## 5. Data-licence review summary

- Government sources (NWS, NOAA, Census): free to reuse. Keep attribution and rate limits. Low risk.
- Google first-party APIs (Search Console, GBP): own data, OAuth, store only what is needed. Low risk.
- Keyword Planner: usage rules tie to an Ads account. Medium risk. Confirm before storing.
- Permit portals: licence per city. Medium risk. Record licence per feed.
- Review/forum sources: high risk. Official API plus terms review required before any storage.

## 6. Proposed crawl policy (decision deferred to Phase 1; stated now for sign-off)

| Bot | Proposed | Reason |
|-----|----------|--------|
| Googlebot, Bingbot | Allow | Core discovery |
| OAI-SearchBot, PerplexityBot | Allow | Appear in answer-engine search results |
| GPTBot, ClaudeBot, Google-Extended | Owner choice (default Allow) | Training-use crawlers; allowing is not a ranking lever and blocking Google-Extended does not affect Google Search |

Never block `/` or the sitemap for any search bot. `llms.txt` is optional and low priority.

## 7. Stack notes for Phase 1 (not decided yet)

Astro (static/SSR) is the lean choice for content pages and Core Web Vitals. Next.js only if the owner wants it for the app shell. Fastify + PostgreSQL (+pgvector) + Redis per the brief. The brief also lists Hostinger/Vercel connectors as available; hosting choice goes to the Phase 1 plan.

## 8. Open questions and sign-off items

1. Supply blocking inputs 1-7 above. Without 4, B cannot be evaluated; without 2, no ZIP list exists.
2. **Approve the accent reinterpretation** (section 1) and berry #a31d4b, or name a different hue to test.
3. Approve Option A (or provide fleet colors for B).
4. Approve the demand-source shortlist and the "no review mining" exclusion.
5. Choose the crawler policy for training bots (section 6).
6. Confirm the country is US.

**Gate:** owner approves sources and design direction. Phase 1 does not start until then.
