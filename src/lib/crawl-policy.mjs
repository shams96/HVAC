// Crawl policy: one documented decision per bot. Bot names checked against each vendor's published docs on 2026-11-23
// (Anthropic: ClaudeBot, Claude-SearchBot, Claude-User; OpenAI: GPTBot, OAI-SearchBot, ChatGPT-User; Perplexity: PerplexityBot,
// Perplexity-User; Apple: Applebot, Applebot-Extended; Google: Googlebot, Google-Extended; Common Crawl: CCBot; Microsoft: Bingbot).
// kind "search": builds a search or answer index, so blocking it removes the site from that product.
// kind "user": fetches a page because a person asked an assistant about it. Some of these ignore robots.txt (sources disagree for
//   Perplexity-User, and OpenAI's docs say robots rules may not apply to ChatGPT-User), so the rule documents intent only.
// kind "training": robots.txt token or crawler used to collect model training data. DEFAULT ALLOW IS PENDING THE OWNER'S DECISION.
export const crawlPolicy = [
  { agent: "Googlebot", kind: "search", rule: "Allow", why: "Google Search discovery" },
  { agent: "Bingbot", kind: "search", rule: "Allow", why: "Bing discovery; Bing data also feeds several answer products" },
  { agent: "Applebot", kind: "search", rule: "Allow", why: "Apple Spotlight, Siri and Safari suggestions" },
  { agent: "OAI-SearchBot", kind: "search", rule: "Allow", why: "ChatGPT search results" },
  { agent: "Claude-SearchBot", kind: "search", rule: "Allow", why: "Claude search results" },
  { agent: "PerplexityBot", kind: "search", rule: "Allow", why: "Perplexity search index" },
  { agent: "ChatGPT-User", kind: "user", rule: "Allow", why: "page fetched when a ChatGPT user asks about it" },
  { agent: "Claude-User", kind: "user", rule: "Allow", why: "page fetched when a Claude user asks about it" },
  { agent: "Perplexity-User", kind: "user", rule: "Allow", why: "page fetched when a Perplexity user follows a citation" },
  { agent: "GPTBot", kind: "training", rule: "Allow", why: "OpenAI training crawler; allow is the default pending owner decision" },
  { agent: "ClaudeBot", kind: "training", rule: "Allow", why: "Anthropic training crawler; allow is the default pending owner decision" },
  { agent: "Google-Extended", kind: "training", rule: "Allow", why: "Gemini training control token; does not affect Google Search; default pending owner decision" },
  { agent: "Applebot-Extended", kind: "training", rule: "Allow", why: "Apple model training control token; does not affect Applebot search; default pending owner decision" },
  { agent: "CCBot", kind: "training", rule: "Allow", why: "Common Crawl dataset crawler; default pending owner decision" },
];

export function buildRobotsTxt(policy, sitemapUrl) {
  const lines = ["# Crawl policy: one decision per bot. Training-bot rows are defaults pending the owner's decision.", ""];
  for (const p of policy) lines.push(`# ${p.kind}: ${p.why}`, `User-agent: ${p.agent}`, `${p.rule}: /`, "");
  lines.push("User-agent: *", "Allow: /", "", `Sitemap: ${sitemapUrl}`, "");
  return lines.join("\n");
}
