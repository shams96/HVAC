// Tells IndexNow-participating search engines (Bing and others) which URLs changed. Run after a PRODUCTION deploy:
//   SITE_URL=https://example.com INDEXNOW_KEY=<key> node scripts/indexnow.mjs
// Refuses to run against a noindex (staging) build or a localhost URL. The key is public by design (it is served as /<key>.txt).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function buildPayload(urls, siteUrl, key) {
  const { host, origin } = new URL(siteUrl);
  const list = urls.filter((u) => new URL(u).origin === origin);
  if (!list.length) throw new Error("no URLs on the site origin to submit");
  return { host, key, keyLocation: `${origin}/${key}.txt`, urlList: list };
}

export const sitemapUrls = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

async function main() {
  const siteUrl = process.env.SITE_URL;
  const key = process.env.INDEXNOW_KEY;
  if (!siteUrl || !key) throw new Error("SITE_URL and INDEXNOW_KEY are required");
  if (/localhost|127\.0\.0\.1/.test(siteUrl)) throw new Error("refusing: SITE_URL is local");
  if (/<meta name="robots" content="noindex/.test(readFileSync("dist/index.html", "utf8"))) throw new Error("refusing: dist is a noindex build");
  const payload = buildPayload(sitemapUrls(readFileSync("dist/sitemap-0.xml", "utf8")), siteUrl, key);
  const res = await fetch("https://api.indexnow.org/indexnow", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(payload) });
  console.log(`IndexNow responded ${res.status} for ${payload.urlList.length} URLs`);
  if (res.status >= 400) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
