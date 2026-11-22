# Phase 2 prep: templates that do not need owner facts

Owner decision (2026-11-21): continue building everything that is not technically blocked; revisit the blockers (owner facts, Node/Astro 7) at the end.

## Spec (what/why)
Page templates and gates for service-area, ZIP and service pages, so Phase 2 content work is "fill the data file", not "build pages". Solved when: with empty data the site builds and shows pending states; with fixture data the templates render and pass gates; production builds cannot ship fixture data or invented facts.

In scope: data model, build-time content gates, schematic service-area view, ZIP page, service page, JSON-LD builders (non-null facts only), unit tests for gates and JSON-LD, Lighthouse on a ZIP page and a service page.
Out of scope: real copy, real ZIP geometry map, geolocation, DB/pipeline (Phase 3), chat agent, social.

## Plan
- `src/data/service-areas.ts`, `src/data/services.ts`: typed, **empty by default**. `USE_FIXTURES=1` loads `src/data/fixtures.ts` (obviously fake: "Sampleville", ZIPs 00001-00003, text prefixed FIXTURE). Fixture builds are noindex and are blocked in production.
- `src/lib/gates.mjs`: pure functions. Active ZIP needs unique slug and ZIP, >=1 owner-approved local job, >=1 local fact with a source URL, no job summary copied across ZIPs. Service needs approved flag, direct answer, scope, price drivers, and pricing that is "free estimate" or an approved amount. Failures throw at build time.
- `src/lib/jsonld.mjs`: pure builders; return `null` unless required owner facts exist; Offer only from approved pricing; no AggregateRating/FAQ here (needs displayed reviews/questions).
- Pages: `/service-area/` (coverage table + schematic travel-band SVG + ZIP lookup progressively enhanced), `/service-area/[slug]/`, `/services/[slug]/`.
- Schematic view is by travel band, **not geographic**. A real map needs ZCTA boundaries (US Census, public domain) and is deferred.

## Tasks
1. Gates and JSON-LD modules + `node --test` tests (including negative cases).
2. Data model, fixtures, fixture/production guards.
3. Components and pages.
4. Build empty, build with fixtures, audit, Lighthouse on ZIP and service page.
5. Converge and revisit blockers.

## Converge (2026-11-21)
Built: data model (empty by default), fixtures (fake, noindex, production-blocked), `gates.mjs` (build-time content gates), `jsonld.mjs` (non-null facts only), `/service-area/`, `/service-area/[slug]/`, `/services/[slug]/`, schematic travel-band view, ZIP lookup (progressive enhancement).
Verified: 20/20 unit tests incl. negatives (duplicate ZIP/slug, copied job text, unsourced fact, unapproved service, bad pricing, partial NAP, `</script>` escaping); empty build = 2 pages; fixture build = 6 pages with full text in raw HTML, 0 scripts on ZIP/service pages, canonical, noindex; with dummy facts: fixtures are refused in production, and no-fixture build is indexable with HVACBusiness JSON-LD and `tel:` link (dummy facts reverted); audit passes.
Lighthouse mobile (fixture build, local preview): ZIP page 99/100/100/66, service page 100/100/100/66, service-area index 100/100/100/66; LCP 1.2 s. ZIP-page CLS 0.056 (target <0.1; cause not traced). SEO 66 = intentional noindex on fixture builds.
Bug caught and fixed: JSON-LD `<` escape had a single backslash in source, so it escaped nothing; confirmed through the real layout with a hostile string. Lesson: after writing backslashes through file tools, verify bytes (`od -c`).
Not done: real ZIP geometry map, geolocation, DB/pipeline, chat agent, social, INP field data, real copy (needs owner facts).
