# 07 Site redesign (visual and UX lift)

Skills used: ui-ux-pro-max (design-system, landing, ux, product searches), landing-page-design, spec-driven-development.
Date: 2026-11-22. Trigger: owner feedback that the site was dull, had no pictures, and printed "service area pending" despite stating the area (DFW).

## Why it was dull (diagnosis, not opinion)

1. No photography anywhere, so nothing human or physical on the page.
2. One flat ivory and white palette with no dark or brand bands carrying weight, so no contrast of rhythm.
3. A single-column list layout for services, a diagram (travel bands) that needs a branch address we do not have, and an empty section message.
4. No motion beyond one hero fade, so nothing rewards scrolling.
5. Public copy leaked internal status ("the owner has not yet supplied the ZIP list").

## Research (what to copy, what to refuse)

- Skill search "home services hvac": Trust and Authority pattern, Conversion Optimised: proof next to the primary action, one primary CTA, visible contact details, no hidden credentials. Adopted.
- Skill landing patterns: hero, proof, solution, CTA path; low friction form (one field). Adopted: one ZIP field with an instant answer.
- Skill palette suggestion (navy and blue, safety orange): refused. The owner approved teal and berry, and all contrast pairs already pass.
- Skill style effects (badge hover, smooth stat reveal): adopted as card lift and scroll reveals, transform and opacity only, 150 to 700 ms, reduced motion honoured.
- landing-page-design: mandatory tagline reveal section (words activate one at a time on scroll), real copy, no invented facts, no gradients, one typeface. Adopted. Its hero text gradient is refused: the repo audit bans every gradient.
- Photography: free commercial licence (Pexels), re-encoded to WebP, a visible brand logo cropped out, EXIF removed. Stock is labelled as stock in the footer and never described as the team or its work.

## What changes

1. Real photography: hero, homes, commercial, warmth, controls, rooftop. Responsive `srcset`, explicit width and height (no layout shift), lazy loading below the fold.
2. Rhythm: ivory, white, teal and a dark ink band alternate; larger display type; asymmetric hero with floating proof cards over the photo.
3. Service area: replace the pending message with the stated area (Dallas, Tarrant, Collin, Denton counties) and an instant ZIP check against 206 ZIP codes derived from US Census data (ZIP code tabulation areas whose land is at least half inside those four counties). Per ZIP landing pages stay gated behind approved local jobs and sourced facts; that gate prevents thin doorway pages and is unchanged.
4. Motion: scroll reveals, word by word tagline reveal, card lift and photo zoom on hover, all gated by `prefers-reduced-motion`.
5. Footer and 404 get structure; legal pages get a calmer layout.

## Not claimed, still pending the owner

Company name, phone, booking, licence numbers, address and hours remain placeholders. Services and prices are not invented. The county list and ZIP set are derived from the stated DFW area and need the owner's confirmation of the edges. Photos are stock until the owner supplies real ones.

## Tasks

Data (coverage), tokens, icons, photo component, coverage form with instant check, global styles and reveal script, home, service area, 404, legal, audit pairs, verify at 1440 and 390, Lighthouse, preview for approval (no deploy).
