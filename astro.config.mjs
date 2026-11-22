import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// SITE_URL is supplied at build time once the domain is confirmed (owner item).
const site = process.env.SITE_URL ?? "http://localhost:4321";

export default defineConfig({
  site,
  output: "static",
  integrations: [sitemap()],
});
