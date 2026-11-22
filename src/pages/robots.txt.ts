import type { APIRoute } from "astro";

// Crawl policy, one decision per bot (Phase 0 proposal; owner confirms the training-bot rows).
const policy: { agent: string; rule: "Allow" | "Disallow"; why: string }[] = [
  { agent: "Googlebot", rule: "Allow", why: "core search discovery" },
  { agent: "Bingbot", rule: "Allow", why: "core search discovery; also feeds several AI answer products" },
  { agent: "OAI-SearchBot", rule: "Allow", why: "answer-engine search results" },
  { agent: "PerplexityBot", rule: "Allow", why: "answer-engine search results" },
  { agent: "GPTBot", rule: "Allow", why: "training crawler; default allow pending owner decision" },
  { agent: "ClaudeBot", rule: "Allow", why: "training crawler; default allow pending owner decision" },
  { agent: "Google-Extended", rule: "Allow", why: "AI-training control token; does not affect Google Search" },
];

export const GET: APIRoute = ({ site }) => {
  const lines = policy.flatMap((p) => [`# ${p.why}`, `User-agent: ${p.agent}`, `${p.rule}: /`, ""]);
  lines.push("User-agent: *", "Allow: /", "", `Sitemap: ${new URL("sitemap-index.xml", site).href}`, "");
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
