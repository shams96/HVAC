import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { execFileSync } from "node:child_process";

// SITE_URL is supplied at build time once the domain is confirmed (owner item).
const site = process.env.SITE_URL ?? "http://localhost:4321";

// Pages that never belong in the sitemap: noindex pages and the 404. The request page is indexable only when its API exists.
const leadsApiOpen = Boolean(process.env.PUBLIC_LEADS_API);
const excluded = new Set(["/404/", "/privacy/", "/terms/", ...(leadsApiOpen ? [] : ["/request/"])]);

// Static pages: lastmod is the date of the last commit that touched the page's source file (a real change date, never "today").
// Pages generated from data (service pages, ZIP pages) would use the row's own last-verified date; none exist yet.
const sources = { "/": "src/pages/index.astro", "/service-area/": "src/pages/service-area/index.astro", "/request/": "src/pages/request.astro" };
function lastCommit(file) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out ? new Date(out).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

export default defineConfig({
  site,
  output: "static",
  integrations: [
    sitemap({
      filter: (page) => !excluded.has(new URL(page).pathname),
      serialize(item) {
        const src = sources[new URL(item.url).pathname];
        const lastmod = src ? lastCommit(src) : undefined;
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
  ],
});
