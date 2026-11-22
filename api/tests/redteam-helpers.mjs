// Red-team helpers (not a test file: the runner glob is redteam-*.test.mjs). Read-only use of src/ and existing helpers.
import { setup as baseAgentSetup } from "./agent-helpers.mjs";

// The public routes are rate limited per IP (per route). Red-team conversations are many, so lift the per-route caps;
// the dedicated rate-limit tests use the real defaults via baseAgentSetup instead.
export const OPEN_LIMITS = { limits: { start: 1e9, message: 1e9, confirm: 1e9, reject: 1e9 } };
export const agentSetup = (o = {}) => baseAgentSetup({ ...o, agentOpts: { ...OPEN_LIMITS, ...(o.agentOpts ?? {}) } });

// Deterministic PRNG (mulberry32) so fuzz failures replay exactly.
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(next() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  return { next, pick, int, chance: (p) => next() < p };
}

// ASCII smuggling: encode text in the invisible Unicode Tags block.
export const toTagChars = (s) => Array.from(s, (c) => String.fromCodePoint(0xe0000 + c.codePointAt(0))).join("");
export const hasTagChars = (s) => /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u.test(s);

export const stringify = (x) => JSON.stringify(x);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Collects every string that failed a predicate, so a failing test names all the escapes at once.
export const escapes = (items, predicate) => items.filter((x) => !predicate(x));
