// Builds the Cloudflare Workers static-assets `_headers` file from the built HTML: a CSP whose inline script and style blocks
// are allowed by hash (no 'unsafe-inline' for scripts), plus the standard hardening headers and cache rules.
import { createHash } from "node:crypto";

export const sha256 = (text) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

export function inlineBlocks(html) {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  return { scripts: scripts.filter((s) => s.trim() !== ""), styles: styles.filter((s) => s.trim() !== "") };
}

export function buildCsp({ scriptHashes, styleHashes, connectOrigins }) {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(" ")}`.trim(),
    `style-src 'self' ${styleHashes.join(" ")}`.trim(),
    "style-src-attr 'unsafe-inline'", // inline style="" attributes (animation delays); attributes cannot carry hashes
    "img-src 'self' data:",
    "font-src 'self' data:", // the bundler inlines small font files as data: URIs; found by checking the live response, not the local server
    `connect-src 'self' ${connectOrigins.join(" ")}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

const originOf = (u) => {
  try { return new URL(u).origin; } catch { return null; }
};

export function buildHeaders({ htmlFiles, noindex, apiUrls = [] }) {
  const scriptHashes = new Set();
  const styleHashes = new Set();
  for (const html of htmlFiles) {
    const { scripts, styles } = inlineBlocks(html);
    scripts.forEach((s) => scriptHashes.add(sha256(s)));
    styles.forEach((s) => styleHashes.add(sha256(s)));
  }
  const connectOrigins = [...new Set(apiUrls.map(originOf).filter(Boolean))];
  const csp = buildCsp({ scriptHashes: [...scriptHashes], styleHashes: [...styleHashes], connectOrigins });
  const lines = [
    "/*",
    `  Content-Security-Policy: ${csp}`,
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()",
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Strict-Transport-Security: max-age=31536000",
  ];
  if (noindex) lines.push("  X-Robots-Tag: noindex, nofollow"); // staging: also keeps robots.txt, sitemap and llms.txt out of indexes
  lines.push(
    "",
    "/_astro/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
    "/img/*",
    "  Cache-Control: public, max-age=86400",
    "",
    "/brand/*",
    "  Cache-Control: public, max-age=86400",
    ""
  );
  return lines.join("\n");
}
