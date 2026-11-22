// Shared defences against look-alike text: digits in other scripts, homoglyph letters, leet spelling, disguised phone numbers.
// Used by the agent output guard, the scope check, the catalog price extractor and the social content policy.
import { INVISIBLE, TAGS, HOMOGLYPH } from "./text.mjs";

// Any Unicode decimal digit becomes its ASCII digit. Decimal-digit scripts come in runs of ten starting at a zero.
export function asciiDigits(s) {
  return String(s ?? "").replace(/\p{Nd}/gu, (d) => {
    const cp = d.codePointAt(0);
    if (cp < 128) return d;
    let zero = cp;
    while (zero > 0x80 && /^\p{Nd}$/u.test(String.fromCodePoint(zero - 1))) zero--;
    return String((cp - zero) % 10);
  });
}

// Lowercase and swap Cyrillic / Greek look-alike letters for Latin ones. Everything else is kept.
export const foldHomoglyphs = (s) => Array.from(String(s ?? "").toLowerCase(), (c) => HOMOGLYPH[c] ?? c).join("");
export const stripMarks = (s) => String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "");

// Digits next to a letter stand for a letter: "numb3r 0ne" -> "number one", "pr1ce" -> "price".
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b" };
export function leetFold(s) {
  const t = String(s ?? "");
  return t.replace(/[0-9]/g, (d, i) => (/[a-z]/.test(t[i - 1] ?? "") || /[a-z]/.test(t[i + 1] ?? "") ? LEET[d] ?? d : d));
}

const escapeRe = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const plain = (s) => foldHomoglyphs(stripMarks(asciiDigits(String(s ?? "").normalize("NFKC")))).replace(INVISIBLE, "").replace(TAGS, "");

// Returns the first banned claim found in text, however it is spaced, punctuated, accented, homoglyphed or leet-spelled; else null.
export function bannedClaimHit(text, claims) {
  const low = plain(text);
  const leet = leetFold(low);
  const alnum = (x) => x.replace(/[^a-z0-9]/g, "");
  const views = [low, leet];
  const squashed = [alnum(low), alnum(leet)];
  for (const claim of claims ?? []) {
    const c0 = plain(claim).replace(/\s+/g, " ").trim();
    if (!c0) continue;
    const c1 = leetFold(c0);
    if (views.some((v) => v.includes(c0) || v.includes(c1))) return claim;
    const k0 = alnum(c0);
    const k1 = alnum(c1);
    if (k0.length >= 6 && squashed.some((sq) => sq.includes(k0) || sq.includes(k1))) return claim;
    if (/[^a-z0-9\s]/.test(c0)) {
      // a symbol claim such as "#1": allow filler between its characters ("# 1", "#-1")
      const re = new RegExp(Array.from(c0.replace(/\s+/g, "")).map(escapeRe).join("[\\s\\W_]{0,3}"), "i");
      if (re.test(low)) return claim;
    }
  }
  return null;
}

// ---------- phone numbers in any disguise ----------
const KEYPAD = { a: 2, b: 2, c: 2, d: 3, e: 3, f: 3, g: 4, h: 4, i: 4, j: 5, k: 5, l: 5, m: 6, n: 6, o: 6, p: 7, q: 7, r: 7, s: 7, t: 8, u: 8, v: 8, w: 9, x: 9, y: 9, z: 9 };
const LOOKALIKE = { o: 0, l: 1, i: 1, s: 5, b: 8, z: 2 };
const DIGIT_WORDS = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", niner: "9" };
const SEP_WORDS = new Set(["dash", "dot", "slash", "hyphen", "point", "period", "underscore"]);

function spokenRuns(t) {
  const toks = t.toLowerCase().match(/[a-z]+|\d+/g) ?? [];
  const out = [];
  let cur = "";
  let words = 0;
  const flush = () => {
    if (words > 0 && cur) out.push({ d: cur, words });
    cur = "";
    words = 0;
  };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (/^\d+$/.test(tk)) cur += tk;
    else if (Object.hasOwn(DIGIT_WORDS, tk)) { cur += DIGIT_WORDS[tk]; words++; }
    else if ((tk === "triple" || tk === "double") && Object.hasOwn(DIGIT_WORDS, toks[i + 1] ?? "")) { cur += DIGIT_WORDS[toks[i + 1]].repeat(tk === "triple" ? 3 : 2); words += 2; i++; }
    else if (!SEP_WORDS.has(tk)) flush();
  }
  flush();
  return out;
}

// Every phone-number-like thing in text. Each candidate is a list of alternative digit strings (letters can be read two ways).
export function phoneCandidates(raw) {
  const t = asciiDigits(String(raw ?? "").normalize("NFKC"));
  const w = t.replace(/\s+(?:dash|dot|slash|hyphen|period|point|underscore)\s+/gi, "-");
  const out = [];
  const nanp = (d) => /^1?[2-9]\d{2}[2-9]\d{6}$/.test(d);
  for (const m of w.matchAll(/\+?\d[\d\s().-]{8,}\d/g)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length >= 10 && d.length <= 11) out.push([d]);
  }
  for (const m of w.matchAll(/(?<![0-9])(\d{3})[^A-Za-z0-9\n]{1,3}(\d{3})[^A-Za-z0-9\n]{1,3}(\d{4})(?![0-9])/g)) {
    const d = m[1] + m[2] + m[3];
    if (nanp(d)) out.push([d]);
  }
  // Letters standing in for digits: vanity numbers (1-800-GOT-HEAT) and look-alikes (212-555-O199).
  for (const m of w.matchAll(/(?<![A-Za-z0-9])(?:\+?1[\s.\-/_]*)?\(?([2-9]\d{2})\)?[\s.\-/_]*([A-Za-z0-9]{3})[\s.\-/_]*([A-Za-z0-9]{4})(?![A-Za-z0-9])/g)) {
    const tail = m[2] + m[3];
    if (!/[A-Za-z]/.test(tail)) continue;
    const map = (table) => m[1] + Array.from(tail.toLowerCase(), (c) => (/[0-9]/.test(c) ? c : table[c] ?? "")).join("");
    out.push([map(KEYPAD), map(LOOKALIKE)]);
  }
  // Seven-digit local numbers.
  for (const m of w.matchAll(/(?<![0-9])([2-9]\d{2})[\s.\-_/](\d{4})(?![0-9])/g)) out.push([m[1] + m[2]]);
  for (const r of spokenRuns(w)) {
    if (r.d.length === 10 || r.d.length === 11 || (r.d.length === 7 && r.words >= 7)) out.push([r.d]);
  }
  return out;
}
