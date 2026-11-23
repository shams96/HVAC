// Checks a built dist folder for search and AI-visibility defects. Returns a list of problems (empty = pass).
// requireRealUrl: fail on any localhost URL (use for any build meant to be indexable or to be shown with a real address).
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { crawlPolicy } from "../../src/lib/crawl-policy.mjs";
import { inlineBlocks, sha256 } from "./headers.mjs";

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const attr = (html, re) => html.match(re)?.[1];

export function verifyDist(dist, { requireRealUrl = false } = {}) {
  const problems = [];
  const fail = (m) => problems.push(m);
  const read = (f) => readFileSync(join(dist, f), "utf8");
  const pages = walk(dist).filter((f) => f.endsWith(".html"));
  const pageHtml = new Map(pages.map((f) => [f, readFileSync(f, "utf8")]));
  const isNoindex = (html) => /<meta name="robots" content="noindex/.test(html);
  const indexableBuild = !isNoindex(read("index.html"));

  for (const [file, html] of pageHtml) {
    const name = file.replace(dist, "").replace(/\\/g, "/");
    if (!/<title>[^<]+<\/title>/.test(html)) fail(`${name}: missing <title>`);
    if (!/<meta name="description" content="[^"]+"/.test(html)) fail(`${name}: missing meta description`);
    const canonical = attr(html, /<link rel="canonical" href="([^"]+)"/);
    if (!canonical || !/^https?:\/\//.test(canonical)) fail(`${name}: canonical missing or not absolute`);
    const og = attr(html, /<meta property="og:image" content="([^"]+)"/);
    if (!og || !/^https?:\/\//.test(og)) fail(`${name}: og:image missing or not absolute`);
    if (!/<meta name="twitter:card" content="summary_large_image"/.test(html)) fail(`${name}: twitter:card is not summary_large_image`);
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try { JSON.parse(m[1]); } catch { fail(`${name}: JSON-LD does not parse`); }
    }
    if (requireRealUrl && /localhost|127\.0\.0\.1/.test(html)) fail(`${name}: contains a localhost URL`);
  }

  if (!existsSync(join(dist, "robots.txt"))) fail("robots.txt missing");
  else {
    const robots = read("robots.txt");
    for (const p of crawlPolicy) {
      const n = robots.split("\n").filter((l) => l === `User-agent: ${p.agent}`).length;
      if (n !== 1) fail(`robots.txt: ${p.agent} has ${n} rules (expected exactly one)`);
    }
    if (!/^Sitemap: https?:\/\//m.test(robots)) fail("robots.txt: Sitemap line missing or not absolute");
    if (requireRealUrl && /localhost/.test(robots)) fail("robots.txt: localhost URL");
  }

  if (!existsSync(join(dist, "sitemap-0.xml"))) fail("sitemap-0.xml missing");
  else {
    const xml = read("sitemap-0.xml");
    const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
    for (const u of urls) {
      const loc = attr(u, /<loc>([^<]+)<\/loc>/);
      if (!/<lastmod>[^<]+<\/lastmod>/.test(u)) fail(`sitemap: ${loc} has no lastmod`);
      const path = new URL(loc).pathname;
      if (["/404/", "/privacy/", "/terms/"].includes(path)) fail(`sitemap: ${path} must not be listed`);
      if (indexableBuild) {
        const f = join(dist, path, "index.html");
        if (existsSync(f) && isNoindex(readFileSync(f, "utf8"))) fail(`sitemap: ${path} is noindex but listed`);
      }
    }
    if (requireRealUrl && /localhost/.test(xml)) fail("sitemap: localhost URL");
  }

  if (!existsSync(join(dist, "llms.txt"))) fail("llms.txt missing");
  else {
    const t = read("llms.txt");
    if (/\b(null|undefined)\b/.test(t)) fail("llms.txt: prints a missing value");
    if (requireRealUrl && /localhost/.test(t)) fail("llms.txt: localhost URL");
  }

  if (!existsSync(join(dist, "og.png"))) fail("og.png missing");

  if (!existsSync(join(dist, "_headers"))) fail("_headers missing");
  else {
    const h = read("_headers");
    const csp = attr(h, /Content-Security-Policy: (.+)/) ?? "";
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src")) ?? "";
    if (!csp) fail("_headers: no Content-Security-Policy");
    if (scriptSrc.includes("'unsafe-inline'")) fail("_headers: script-src allows 'unsafe-inline'");
    for (const html of pageHtml.values()) {
      for (const s of inlineBlocks(html).scripts) if (!scriptSrc.includes(sha256(s))) fail("_headers: an inline script is not covered by a CSP hash");
    }
    if (!indexableBuild && !/X-Robots-Tag: noindex/.test(h)) fail("_headers: noindex build lacks X-Robots-Tag");
    if (indexableBuild && /X-Robots-Tag: noindex/.test(h)) fail("_headers: indexable build sends X-Robots-Tag noindex");
  }
  return problems;
}
