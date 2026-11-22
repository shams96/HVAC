# Phase 1: Foundation (spec, plan, tasks)

Gate input: owner approved **Option A + berry #a31d4b** (design direction and accent reinterpretation). Demand-source shortlist not yet explicitly approved. It does not block Phase 1; it blocks the demand build in later phases.

## Spec (what/why)
A static-first, server-rendered skeleton where every later page inherits tokens, header, crawl policy and audits. Solved when: build succeeds, raw HTML contains full text, every token pair in use passes the contrast script, robots/sitemap/canonical exist, and no structured data or business fact is emitted without owner confirmation.

Out of scope: real copy, ZIP pages, backend, CRM, chat, social, analytics vendor choice, hosting choice.

## Plan
- **Astro 5, static output**, no UI framework (zero client JS by default; best path to LCP/INP targets).
- `src/styles/tokens.css` is the only place hex values appear. Components use `var(--*)`.
- `src/data/business.ts` holds NAP and facts, every field `null` until owner-supplied. Pages render a visible "pending" state in dev and **fail the production build** if a required field is null (prevents shipping invented facts).
- JSON-LD generated only from non-null fields in that file; emitted nowhere while it is empty.
- Fonts: self-hosted Inter variable via `@fontsource-variable/inter`; no serif yet (decided at layout review).
- `public/robots.txt` per the approved policy; sitemap via `@astrojs/sitemap` with the site URL taken from env once the domain is known.
- `scripts/contrast-audit.mjs` parses tokens.css and checks the declared pair table (WCAG 1.4.3 / 1.4.11), exits non-zero on failure.

## Tasks
1. Scaffold project and install deps.
2. tokens.css with palette, type scale, spacing, focus, reduced-motion.
3. Base layout: header with phone + Book button on every screen, mobile sticky bar, skip link, canonical.
4. Home skeleton: direct-answer hero (placeholders), ZIP field, service-area-map slot, hero reveal (only motion, honors reduced motion).
5. robots.txt + sitemap config.
6. contrast-audit script wired to `npm run audit`.
7. Build, verify raw HTML text present, run audit.

## Open
Domain, phone number and booking URL are unknown, so the header uses clearly marked placeholders (`tel:` omitted until supplied).

## Converge (2026-11-21)
Verified: contrast audit 12/12 pass; token-discipline check passes (no hex outside tokens.css); default production build refuses with missing facts; staging build (`ALLOW_PLACEHOLDERS=1`) emits full text in raw HTML, 0 script tags, noindex, absolute canonical, robots.txt with per-bot decisions and absolute Sitemap, sitemap index. `npm audit`: 0 vulnerabilities on astro 7.4.13 (astro 5.x and 6.x are flagged critical; 7.3.8 also flagged).
Caveat: the staging build was run on a throwaway Astro 6 copy because the installed Node (22.17.0) is below Astro 7's floor (>=22.23.4). Astro 7 itself has not been built here.
Not done: Lighthouse (needs a real page and a browser run), sitemap lastmod, JSON-LD (no confirmed facts yet), analytics, service-area map, ZIP pages.

## Unit conventions (added on owner request)
Global rule, tokens in `tokens.css`: **rem** for text (and touch targets, `--touch-min: 2.75rem`), **%** for layouts (`--layout-*`), **vw** for full-screen sections (`--section-full`, `--section-bleed-offset`, `.full-bleed`; `body { overflow-x: clip }` guards scrollbar-width overflow), **px** for borders and focus rings (`--border-thin`, `--border-strong`, `--focus-width`). `npm run audit` now fails on px font-size and on rem/em border or outline values; negative-tested.

## Decision: stay on Astro 6.4.8 for now (owner, 2026-11-21)
Reason: patched Astro 7.4.13 needs Node >=22.23.4; installed Node is 22.17.0. `npm audit` on 6.4.8 reports astro (critical), esbuild (high, dev server on Windows), sharp (high, image libs). **Inferred, not verified:** exposure is reduced because the site is static output with no SSR, server islands, MDX, or image optimization pipeline in use, and the dev server is not exposed. **Rule:** run only `astro build` output in production; never expose `astro dev`; do not add `<Image>`/sharp-backed features or SSR adapters on Astro 6. **Revisit:** upgrade to Astro 7.4.13 once Node >=22.23.4 is installed, and set `engines` back. This is a hard prerequisite before first ship (predeploy-security-audit).
Verified on the real project: Astro 6.4.8 builds with `ALLOW_PLACEHOLDERS=1`; contrast and unit audit pass.

## Lighthouse (mobile, 2026-11-21, home page, local `astro preview` of the placeholder build)
Verified, 3 runs identical: Performance 100, Accessibility 100, Best Practices 96 (one console error: `/favicon.ico` 404), SEO 66. LCP 1.2 s, CLS 0.001, TBT 0 ms.
After adding an empty icon link: Best Practices 100 (1 run).
SEO 66 is one failed audit, `is-crawlable`, caused by the intentional `noindex` on placeholder builds; a real build (facts supplied) omits it. Not re-verified on a production build.
Caveats: local server, simulated mobile throttling, one near-empty page. Says nothing about real pages with images, the map, or edge caching. INP is a field metric and was not measured. Service-page and ZIP-page runs are still owed (acceptance criteria). Needs a real favicon from the owner.

## Landing page (2026-11-21)
Layout A (classic hero plus sections), one primary action: check coverage by ZIP. Sections: hero with coverage-bands visual, services (data driven), static tagline, how it works (true sequence, numbered), where we work, proof (placeholder until real reviews), final CTA. Plus privacy, terms (placeholder pages, attorney text pending), branded 404.
Applied the `landing-page-design` skill: Manrope (Inter dropped), named text styles, spacing steps, Tailwind radius with the nested-radius rule, no single-sided card borders, no background gradients, Phosphor icons, base easing curve, floating translucent nav.
Where the project brief wins over the skill (user instructions outrank skill defaults): solid ink hero heading instead of a gradient (brief bans decorative gradients); tagline section is static, no word-by-word scroll reveal, and no section scroll reveals (brief allows one orchestrated motion, the hero reveal); FAQ, testimonials and proof render only when real data exists (brief forbids invented reviews and FAQ without real customer questions); copy is draft pending owner approval, no invented facts.
Audit now also fails on non-token font sizes, gradients, italics, banned fonts, weights above semibold; negative-tested.
Verified: 390px check (no overflow, 44px targets, ZIP form and call bar in the first screen); desktop overflow bug found and fixed (100vw includes the scrollbar; clip at the root); Lighthouse mobile on home, ZIP, service, service-area pages: 100/100/100, SEO 66 only from the intentional noindex; LCP 1.1 s, CLS 0 to 0.027. JSON-LD escape re-proved through the real layout after the rewrite.
Not done: real copy, photos, logo, favicon, og:image, FAQ, reviews, cookie consent (jurisdiction check pending), chat widget.
