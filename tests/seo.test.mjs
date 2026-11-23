import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crawlPolicy, buildRobotsTxt } from "../src/lib/crawl-policy.mjs";
import { buildLlmsTxt } from "../src/lib/llms.mjs";
import { buildOrganization, buildWebSite, buildBreadcrumbs, isRealSiteUrl } from "../src/lib/jsonld.mjs";
import { buildHeaders, inlineBlocks, sha256 } from "../scripts/lib/headers.mjs";
import { buildPayload, sitemapUrls } from "../scripts/indexnow.mjs";
import { verifyDist } from "../scripts/lib/verify-dist.mjs";

const biz = { brandName: "Test AirWorks", legalName: null, phoneDisplay: null, phoneE164: null, bookingUrl: null, streetAddress: null, city: null, state: "TX", postalCode: null, hours: null, serviceRegion: "the Test area" };
const SITE = "https://example.org";

test("every crawl-policy bot appears exactly once with a reason and a kind", () => {
  const names = crawlPolicy.map((p) => p.agent);
  assert.equal(new Set(names).size, names.length);
  for (const p of crawlPolicy) { assert.ok(p.why.length > 10, p.agent); assert.ok(["search", "user", "training"].includes(p.kind), p.agent); }
  for (const must of ["Googlebot", "Bingbot", "OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "ChatGPT-User", "Claude-User", "GPTBot", "ClaudeBot", "Google-Extended"]) assert.ok(names.includes(must), `missing ${must}`);
  const txt = buildRobotsTxt(crawlPolicy, `${SITE}/sitemap-index.xml`);
  for (const n of names) assert.equal(txt.split("\n").filter((l) => l === `User-agent: ${n}`).length, 1, n);
  assert.match(txt, /^Sitemap: https:\/\/example\.org\/sitemap-index\.xml$/m);
});

test("search bots are never disallowed by default (blocking one would delist the site)", () => {
  for (const p of crawlPolicy.filter((x) => x.kind !== "training")) assert.equal(p.rule, "Allow", p.agent);
});

test("llms.txt lists only approved services and never prints a missing value", () => {
  const services = [
    { slug: "repair", name: "Repair", approved: true, directAnswer: "We fix things." },
    { slug: "draft", name: "Draft service", approved: false, directAnswer: "Not signed off." },
  ];
  const t = buildLlmsTxt({ business: biz, services, areas: [], siteUrl: SITE, counties: ["Dallas County"] });
  assert.match(t, /\[Repair\]\(https:\/\/example\.org\/services\/repair\/\)/);
  assert.ok(!t.includes("Draft service"));
  assert.ok(!/\b(null|undefined)\b/.test(t));
  assert.ok(!/Phone:|Address:|Hours:|Booking:/.test(t), "contact lines must not appear without owner facts");
  const withPhone = buildLlmsTxt({ business: { ...biz, phoneDisplay: "(000) 000-0000" }, services: [], areas: [], siteUrl: SITE, counties: [] });
  assert.match(withPhone, /Phone: \(000\) 000-0000/);
});

test("site-wide JSON-LD is null on a localhost URL and carries no unstated facts on a real one", () => {
  assert.equal(isRealSiteUrl("http://localhost:4321"), false);
  assert.equal(isRealSiteUrl("not a url"), false);
  assert.equal(buildOrganization(biz, "http://localhost:4321"), null);
  assert.equal(buildWebSite(biz, "http://localhost:4321"), null);
  assert.equal(buildBreadcrumbs([{ name: "A", path: "/a/" }], "http://localhost:4321"), null);
  const org = buildOrganization(biz, SITE, ["Dallas County, TX"]);
  for (const k of ["telephone", "address", "aggregateRating", "review", "openingHours", "priceRange"]) assert.equal(k in org, false, k);
  assert.equal(org["@id"], `${SITE}/#business`);
  assert.equal(buildWebSite(biz, SITE).publisher["@id"], org["@id"]);
});

test("breadcrumbs start at Home with consecutive positions and absolute URLs", () => {
  const b = buildBreadcrumbs([{ name: "Service area", path: "/service-area/" }, { name: "Plano 75024", path: "/service-area/plano-75024/" }], SITE);
  assert.deepEqual(b.itemListElement.map((i) => i.position), [1, 2, 3]);
  assert.equal(b.itemListElement[0].item, `${SITE}/`);
  assert.equal(b.itemListElement[2].item, `${SITE}/service-area/plano-75024/`);
});

test("CSP: scripts allowed by hash only, inline blocks hashed, API origin added to connect-src, JSON-LD ignored", () => {
  const html = `<html><head><script>document.x=1;</script><script type="application/ld+json">{"a":1}</script><script src="/a.js"></script><style>a{b:c}</style></head></html>`;
  const { scripts, styles } = inlineBlocks(html);
  assert.deepEqual(scripts, ["document.x=1;"]);
  assert.deepEqual(styles, ["a{b:c}"]);
  const h = buildHeaders({ htmlFiles: [html], noindex: false, apiUrls: ["https://api.example.org/base/path"] });
  const csp = h.match(/Content-Security-Policy: (.+)/)[1];
  const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
  assert.ok(scriptSrc.includes(sha256("document.x=1;")));
  assert.ok(!scriptSrc.includes("unsafe-inline"));
  assert.match(csp, /connect-src 'self' https:\/\/api\.example\.org(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /font-src 'self' data:/, "small fonts are inlined as data: URIs by the bundler");
  assert.ok(!/X-Robots-Tag/.test(h));
  assert.match(buildHeaders({ htmlFiles: [html], noindex: true }), /X-Robots-Tag: noindex, nofollow/);
});

test("IndexNow payload keeps only same-origin URLs and points at the key file", () => {
  const xml = `<urlset><url><loc>${SITE}/</loc></url><url><loc>https://other.test/x</loc></url></urlset>`;
  const p = buildPayload(sitemapUrls(xml), SITE, "abcdef123456");
  assert.deepEqual(p.urlList, [`${SITE}/`]);
  assert.equal(p.host, "example.org");
  assert.equal(p.keyLocation, `${SITE}/abcdef123456.txt`);
  assert.throws(() => buildPayload(["https://other.test/x"], SITE, "abcdef123456"));
});

// Synthetic dist folders: a good one passes; each defect below must be caught (so the verifier can really fail).
function makeDist(mut = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dist-"));
  const script = "document.documentElement.className='js';";
  const page = (extra = "", robots = "") => `<!doctype html><html><head><title>T</title><meta name="description" content="d"><link rel="canonical" href="${SITE}/"><meta property="og:image" content="${SITE}/og.png"><meta name="twitter:card" content="summary_large_image">${robots}<script>${script}</script>${extra}</head><body></body></html>`;
  const files = {
    "index.html": page(mut.ld ?? `<script type="application/ld+json">{"@type":"WebSite"}</script>`, mut.noindexHome ? `<meta name="robots" content="noindex, nofollow">` : ""),
    "robots.txt": mut.robots ?? buildRobotsTxt(crawlPolicy, `${SITE}/sitemap-index.xml`),
    "sitemap-0.xml": mut.sitemap ?? `<urlset><url><loc>${SITE}/</loc><lastmod>2026-11-22T00:00:00.000Z</lastmod></url></urlset>`,
    "llms.txt": mut.llms ?? "# T\n",
    "og.png": "x",
    "_headers": mut.headers ?? buildHeaders({ htmlFiles: [page()], noindex: Boolean(mut.noindexHome) }),
  };
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), c); }
  return dir;
}
const run = (mut, opts) => { const d = makeDist(mut); try { return verifyDist(d, opts); } finally { rmSync(d, { recursive: true, force: true }); } };

test("verifier passes a good build", () => assert.deepEqual(run({}), []));
test("verifier catches broken JSON-LD", () => assert.match(run({ ld: `<script type="application/ld+json">{bad</script>` }).join("|"), /JSON-LD does not parse/));
test("verifier catches a sitemap entry without lastmod", () => assert.match(run({ sitemap: `<urlset><url><loc>${SITE}/</loc></url></urlset>` }).join("|"), /no lastmod/));
test("verifier catches a bot with no rule", () => assert.match(run({ robots: `User-agent: *\nAllow: /\nSitemap: ${SITE}/s.xml\n` }).join("|"), /Googlebot has 0 rules/));
test("verifier catches localhost URLs when a real URL is required", () => {
  assert.match(run({ sitemap: `<urlset><url><loc>http://localhost:4321/</loc><lastmod>2026-11-22</lastmod></url></urlset>` }, { requireRealUrl: true }).join("|"), /localhost/);
});
test("verifier catches a CSP that allows inline scripts", () => {
  assert.match(run({ headers: "/*\n  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'\n" }).join("|"), /unsafe-inline/);
});
test("verifier catches an uncovered inline script and a missing X-Robots-Tag on noindex builds", () => {
  assert.match(run({ headers: "/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'\n" }).join("|"), /not covered by a CSP hash/);
  assert.match(run({ noindexHome: true, headers: buildHeaders({ htmlFiles: [], noindex: false }) }).join("|"), /lacks X-Robots-Tag|not covered/);
});
test("verifier catches noindex pages listed in an indexable sitemap", () => {
  const d = makeDist({ sitemap: `<urlset><url><loc>${SITE}/privacy/</loc><lastmod>2026-11-22</lastmod></url></urlset>` });
  try { assert.match(verifyDist(d).join("|"), /must not be listed/); } finally { rmSync(d, { recursive: true, force: true }); }
});
