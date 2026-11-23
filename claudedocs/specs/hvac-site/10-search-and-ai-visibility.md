# 10 Search, answer-engine and AI-crawl layer (spec + plan phase)

Status: FOR APPROVAL. Nothing built. Written 2026-11-23 after an audit of the live staging build. Evidence tags: **verified** (seen in the live site or repo this session), **inferred** (general knowledge, not checked against current vendor docs), **unknown**.

## Audit: what the live site emits today (verified against https://hvac-site.hvac-site.workers.dev)
| Item | State |
|---|---|
| Indexable | No. `noindex, nofollow` on every page (placeholder build, by design) |
| Canonical, `og:url`, sitemap URLs, robots `Sitemap:` line | All point to `http://localhost:4321` (no `SITE_URL`, no domain) |
| Pages built | 6: home, request, service-area, privacy, terms, 404. **Zero service pages, zero ZIP pages** (`services` and `serviceAreas` data are empty until the owner supplies them) |
| JSON-LD | None emitted (builders exist but are gated on non-null owner facts: legal name, phone, address) |
| FAQ | None (deliberately omitted until real customer questions exist) |
| `llms.txt` | 404 |
| Sitemap | 5 URLs, no `lastmod`, no image entries |
| `og:image`, `twitter:image` | Absent; `twitter:card` is `summary` |
| Security and cache headers | None set (no `_headers` file) |
| robots.txt | One rule per bot: Googlebot, Bingbot, OAI-SearchBot, PerplexityBot, GPTBot, ClaudeBot, Google-Extended, all Allow |
| Rendering | Static HTML, full text in raw HTML (good for crawlers that do not run JavaScript) |
| Lighthouse | Accessibility and performance 100 on /request/. SEO score is capped at 66 by `is-crawlable` on any noindex build, so real SEO cannot be scored until an indexable build exists |

## What exists in code but is switched off by policy gates
Canonical tag, per-bot robots generator, sitemap integration, JSON-LD builders (HVACBusiness, Service), answer-first service template, ZIP landing template with a local-job requirement, query-panel measurement system. The gates are correct (no invented facts); the result is that nothing indexable exists yet.

## Scope (can be built now, no owner facts needed)
1. **Crawl policy, expanded.** Separate search/answer bots from training bots, add the other documented user-triggered and search agents, keep one documented decision per bot, add a Content-Signal line only if the owner approves. Names to verify against each vendor's current docs before shipping (inferred): ChatGPT-User, Claude-SearchBot, Claude-User, Perplexity-User, Applebot-Extended, CCBot.
2. **`llms.txt`** generated from the approved catalog and page list. Optional, no proven ranking effect (stated in the skill), cheap to keep accurate.
3. **Sitemap**: real `lastmod` from the data's `last_verified`, split sitemaps per type when pages exist, absolute URLs from the real domain.
4. **Share cards**: one on-brand OG image, `summary_large_image`, per-page title/description audit (length, uniqueness).
5. **Headers file** (`public/_headers`, supported by Workers static assets, inferred): HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, a strict CSP checked against the real pages, long immutable cache on hashed `/_astro/` assets, short cache on HTML.
6. **Structured data** that needs only already-supplied facts: `WebSite`, `Organization` (brand name, `areaServed` = the four counties), `BreadcrumbList`. `HVACBusiness` with address, phone, hours, licence, and `FAQPage` or `AggregateRating` stay gated on owner facts and real reviews.
7. **Answer-first page pattern** for AEO/GEO: each service and ZIP page opens with a 40 to 60 word direct answer, a scope list, price drivers, then sources for local facts. Citable, quotable, no marketing filler.
8. **IndexNow** key file and a deploy-time ping (Bing and Yandex families use it; Bing data feeds several answer products, inferred).
9. **Verification harness**: a build test that fails if an indexable build has localhost URLs, missing canonical, missing sitemap `lastmod`, invalid JSON-LD, or a bot with no documented decision; Lighthouse SEO on a temporary indexable build with fixture data, labelled as a test.

## Out of scope here (owner-gated, listed so nothing is assumed)
Real service pages, ZIP pages, reviews and review schema, FAQ, photos of real jobs, Google Business Profile, Search Console and Bing Webmaster verification, backlink and citation building, Spanish version, domain and `SITE_URL`.

## What drives search and AI visibility for a local HVAC business (inferred, check before relying)
Google Business Profile completeness and reviews, NAP consistency across directories, real local content per service and area, review volume and recency, Bing indexing (answer products draw on it), and being cited by other sites. The technical layer above removes obstacles; it does not create rankings, and nothing here promises AI recommendations.

## Plan
Order: 5 headers, 1 crawl policy, 3 sitemap, 4 share cards, 2 llms.txt, 6 schema, 8 IndexNow, then 9 tests. Each step has a test and is verified on the built output, not the dev server. Deploy to staging only (still noindex). Estimated as one working pass; the production switch waits on the owner items in `claudedocs/OWNER-CHECKLIST.md` sections A to C.

## Acceptance
Built output for an indexable fixture build passes the harness in step 9; staging stays noindex and byte-for-byte free of fixture data; no claim, rating, address or price appears that the owner has not supplied; Lighthouse accessibility and performance stay 100; existing tests (site 27, API 298) still pass.

## Owner decisions this needs
Training-bot stance (allow or block GPTBot, ClaudeBot, Google-Extended, CCBot), whether to add a Content-Signal line, and the domain (affects every absolute URL).
