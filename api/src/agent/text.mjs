// Text hygiene shared by the pre-checks, the output guard and the prompt builder.

// Invisible / direction-control characters used to hide or reorder text.
export const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
// Unicode Tag characters and variation-selector supplement: invisible to people, readable by models (ASCII smuggling).
export const TAGS = new RegExp("[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]", "gu");
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// Cleans text we store and forward: NFC, no control chars, no invisible/bidi characters.
export function cleanText(s) {
  return String(s ?? "").normalize("NFC").replace(INVISIBLE, "").replace(TAGS, "").replace(CONTROL, "").trim();
}

// Cyrillic / Greek look-alikes that survive NFKD.
export const HOMOGLYPH = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ѕ": "s", "ј": "j", "һ": "h", "ԁ": "d", "ԛ": "q", "ԝ": "w", "ӏ": "l",
  "α": "a", "ε": "e", "ο": "o", "ρ": "p", "ν": "v", "κ": "k", "τ": "t", "υ": "u", "χ": "x", "ι": "i", "β": "b", "η": "n", "μ": "u", "ѵ": "v",
  "ɡ": "g", "ᴏ": "o", "ꜱ": "s", "ʟ": "l", "ᴄ": "c", "ᴀ": "a", "ɪ": "i", "ᴇ": "e", "ᴋ": "k", "ᴍ": "m", "ɴ": "n", "ᴘ": "p", "ʀ": "r", "ᴛ": "t", "ᴜ": "u",
};
const LEET_DIGIT = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t" };
const LEET_SYMBOL = { "@": "a", "$": "s", "!": "i", "|": "l" };

// Lowercase letters and spaces only: accents, invisibles, homoglyphs, leetspeak and repeated letters removed.
// "G4S  l33k!!" -> "gas lek". Used for safety pre-checks only, never shown to anyone.
export function foldForSafety(input) {
  let s = String(input ?? "").normalize("NFKD").replace(/\p{M}/gu, "").replace(INVISIBLE, "").replace(TAGS, "").toLowerCase();
  s = s.replace(/[Ͱ-ϿЀ-ӿɐ-ʯᴀ-ᵿ꜀-ꟿ]/g, (c) => HOMOGLYPH[c] ?? c);
  s = s.replace(/[0-9]/g, (d, i) => (/[a-z]/.test(s[i - 1] ?? "") || /[a-z]/.test(s[i + 1] ?? "") ? LEET_DIGIT[d] ?? d : d));
  s = s.replace(/[@$!|]/g, (c, i) => {
    const before = /[a-z]/.test(s[i - 1] ?? "");
    const after = /[a-z]/.test(s[i + 1] ?? "");
    if (before && after) return LEET_SYMBOL[c];
    if ((c === "@" || c === "$") && after && !before) return LEET_SYMBOL[c];
    return c;
  });
  s = s.replace(/[^a-z]+/g, " ").trim();
  return s.replace(/([a-z])\1+/g, "$1");
}

// Folded form of a literal keyword so patterns and input collapse identically.
export const fold = (w) => foldForSafety(w);

// Tokens of the folded text, with runs of 3+ single letters ("g a s", "f.i.r.e") joined into one token.
export function foldedTokens(input) {
  const raw = foldForSafety(input).split(" ").filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; ) {
    if (raw[i].length === 1) {
      let j = i;
      while (j < raw.length && raw[j].length === 1) j++;
      if (j - i >= 3) { out.push(raw.slice(i, j).join("")); i = j; continue; }
    }
    out.push(raw[i]);
    i++;
  }
  return out;
}

export function levenshtein(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

