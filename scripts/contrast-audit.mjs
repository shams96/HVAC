// Contrast + token-discipline audit. Exits non-zero on any failure.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const css = readFileSync("src/styles/tokens.css", "utf8");
const tokens = Object.fromEntries([...css.matchAll(/--(color-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [foreground token, background token, minimum ratio, role]
const pairs = [
  ["color-on-dark", "color-ink", 4.5, "text on dark band"],
  ["color-on-dark-muted", "color-ink", 4.5, "muted text on dark band"],
  ["color-on-dark", "color-primary", 4.5, "text on teal band"],
  ["color-on-dark-muted", "color-primary", 4.5, "muted text on teal band"],
  ["color-surface-raised", "color-primary", 4.5, "white on teal (step numerals)"],
  ["color-ink", "color-surface", 4.5, "body text"],
  ["color-ink", "color-surface-raised", 4.5, "text on raised panel"],
  ["color-ink-muted", "color-surface", 4.5, "secondary text"],
  ["color-primary", "color-surface", 4.5, "links/brand text on neutral"],
  ["color-surface", "color-primary", 4.5, "header/footer text on teal"],
  ["color-on-accent", "color-accent", 4.5, "button label"],
  ["color-accent", "color-surface", 3.0, "button fill vs neutral (1.4.11)"],
  ["color-accent", "color-surface-raised", 3.0, "button fill vs raised panel (1.4.11)"],
  ["color-surface", "color-primary", 3.0, "button ring vs teal (1.4.11)"],
  ["color-focus", "color-surface", 3.0, "focus ring vs neutral (2.4.11/1.4.11)"],
  ["color-focus", "color-surface-raised", 3.0, "focus ring vs raised panel"],
  ["color-ink-muted", "color-surface-raised", 4.5, "muted text on raised panel"],
  ["color-on-accent", "color-accent-hover", 4.5, "button label on hover"],
  ["color-accent-hover", "color-surface", 3.0, "hover fill vs neutral (1.4.11)"],
  ["color-ink", "color-nav-surface-worst", 4.5, "nav text over blur (worst case: surface at 88% over brand)"],
];

// Worst case for the translucent nav: the neutral surface at 88% opacity over the brand color.
const mix = (a, b, t) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * t + parseInt(b.slice(i, i + 2), 16) * (1 - t)).toString(16).padStart(2, "0")).join("");
tokens["color-nav-surface-worst"] = mix(tokens["color-surface"], tokens["color-primary"], 0.88);

let fail = 0;
for (const [f, b, min, role] of pairs) {
  if (!tokens[f] || !tokens[b]) { console.log(`FAIL missing token ${f}/${b}`); fail++; continue; }
  const r = ratio(tokens[f], tokens[b]);
  const ok = r >= min;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${r.toFixed(2)} (min ${min}) ${role}: ${f} on ${b}`);
}

// Token discipline: no hex outside tokens.css.
const hexRe = /#[0-9a-fA-F]{3,8}\b/;
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
for (const f of walk("src").filter((p) => [".astro", ".css", ".ts", ".md"].includes(extname(p)) && !p.endsWith("tokens.css"))) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    // allow in-page anchors like href="#main" by requiring a hex-looking token not preceded by a quote/slash
    const m = line.match(/(?<![\w"'\/])#[0-9a-fA-F]{6}\b|(?<![\w"'\/])#[0-9a-fA-F]{3}\b(?![\w-])/);
    if (m && !/href=|id=|\/#/.test(line.slice(Math.max(0, m.index - 8), m.index + 1))) { console.log(`FAIL hard-coded color ${m[0]} at ${f}:${i + 1}`); fail++; }
  });
}
// Unit discipline: text in rem (not px); borders/outlines use px tokens (no rem/em literals).
for (const f of walk("src").filter((p) => [".astro", ".css"].includes(extname(p)))) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    if (/font-size:\s*[\d.]+px/.test(line)) { console.log(`FAIL px font-size at ${f}:${i + 1}`); fail++; }
    if (/(border(-[a-z]+)?|outline):[^;]*\b[\d.]+(rem|em)\b/.test(line)) { console.log(`FAIL non-px border/outline at ${f}:${i + 1}`); fail++; }
  });
}
// Design rules: token-only font sizes, no gradients, no italics, no banned fonts, weights capped at semibold.
for (const f of walk("src").filter((p) => [".astro", ".css"].includes(extname(p)))) {
  const isTokens = f.endsWith("tokens.css");
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    const at = `${f}:${i + 1}`;
    if (!isTokens && /font-size:\s*(?!var\(--text-)/.test(line)) { console.log(`FAIL font-size must use a --text-* token at ${at}`); fail++; }
    if (/gradient\(/i.test(line)) { console.log(`FAIL gradient at ${at}`); fail++; }
    if (/font-style:\s*italic|<(i|em)[ >]/i.test(line)) { console.log(`FAIL italic at ${at}`); fail++; }
    if (/\b(Inter|Roboto|Arial|Open Sans|Helvetica)\b/.test(line)) { console.log(`FAIL banned font at ${at}`); fail++; }
    if (/font(-weight)?:[^;]*\b[789]\d\d\b/.test(line)) { console.log(`FAIL weight above semibold at ${at}`); fail++; }
  });
}
console.log(fail ? `\n${fail} failure(s)` : "\nAll checks passed");
process.exit(fail ? 1 : 0);
