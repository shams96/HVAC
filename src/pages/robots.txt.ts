import type { APIRoute } from "astro";
import { crawlPolicy, buildRobotsTxt } from "../lib/crawl-policy.mjs";

export const GET: APIRoute = ({ site }) =>
  new Response(buildRobotsTxt(crawlPolicy, new URL("sitemap-index.xml", site).href), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
