// The approved facts the chat agent and social publisher may rely on. Nothing outside this object is "known".
// Loaded from config/catalog.json (exported from the site's owner-approved data); empty until the owner supplies facts.
import { readFileSync, existsSync } from "node:fs";
import { asciiDigits } from "./agent/lookalike.mjs";

export const emptyCatalog = () => ({
  business: { legalName: null, phoneE164: null, phoneDisplay: null, bookingUrl: null, hours: null },
  services: [],
  areas: [],
  emergencyGuidance: null,
  bannedClaims: [],
});

export function loadCatalog(path = new URL("../config/catalog.json", import.meta.url)) {
  if (!existsSync(path)) return emptyCatalog();
  return validateCatalog({ ...emptyCatalog(), ...JSON.parse(readFileSync(path, "utf8")) });
}

export function validateCatalog(c) {
  const errs = [];
  for (const s of c.services) {
    if (!/^[a-z0-9-]{1,64}$/.test(s.slug ?? "")) errs.push(`service slug invalid: ${s.slug}`);
    if (!["free-estimate", "approved"].includes(s.pricing?.kind)) errs.push(`service ${s.slug}: pricing.kind must be free-estimate or approved`);
    if (s.pricing?.kind === "approved" && !s.pricing.amount) errs.push(`service ${s.slug}: approved pricing needs amount`);
  }
  for (const a of c.areas) if (!/^\d{5}$/.test(a.zip ?? "")) errs.push(`area zip invalid: ${a.zip}`);
  if (errs.length) throw new Error(`Invalid catalog:\n - ${errs.join("\n - ")}`);
  return c;
}

// Numbers that appear after a $ sign, or before "dollars"/"USD", e.g. "$1,299.50" -> 1299.5. Text with no currency yields [].
export function extractDollarAmounts(text) {
  const out = [];
  // Digits of any script and the money-bag emoji read as what a customer sees: ASCII digits and "$".
  const t = asciiDigits(String(text).normalize("NFKC")).replace(/\u{1F4B2}/gu, "$").replace(/[︀-️⃣]/g, "");
  const num = "([0-9][0-9,]*(?:\\.[0-9]{1,2})?)";
  const re = new RegExp(
    `\\$\\s*${num}` + // $99
      `|(?<![0-9.,])${num}\\s*\\$` + // 99$
      `|(?<![0-9.,])${num}[\\s-]*(?:(?:u\\.?s\\.?|american)\\s+)?(?:dollars?|usd|bucks?|smackers|greenbacks?|bux)\\b` + // 99 dollars, 99-dollar, 99 US dollars
      `|\\b(?:usd|us\\$)\\s*[:=]?\\s*${num}`, // USD: 99
    "gi"
  );
  for (const m of t.matchAll(re)) out.push(Number((m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/,/g, "")));
  return out;
}

export const approvedAmounts = (c) =>
  new Set(c.services.filter((s) => s.pricing?.kind === "approved").map((s) => Number(String(s.pricing.amount).replace(/,/g, ""))));

// True only when every currency amount in the text is an owner-approved price. Text with no amounts passes.
export function amountsApproved(text, c) {
  const ok = approvedAmounts(c);
  return extractDollarAmounts(text).every((n) => ok.has(n));
}
