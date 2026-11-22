// A5: deterministic emergency pre-check. Runs BEFORE any model call and decides without the model.
// Conservative on purpose: a false positive costs one canned reply, a false negative can cost a life.
import { fold, foldedTokens, foldForSafety, levenshtein } from "./text.mjs";

const F = (...words) => words.map(fold);
const GAS = new Set(F("gas", "gaz", "propane", "methane", "natgas", "lpg"));
// leak / smell / hiss words (English and Spanish) that make "gas" an emergency report
const LEAKISH_STEMS = F("leak", "leek", "escap", "smell", "odor", "odour", "stink", "stench", "scent", "whiff", "reek", "sulfur", "sulphur", "rotten", "hissing", "hisses", "hissed", "huel", "fuga", "olor", "apest", "pierd");
const SMELL_STEMS = F("smell", "odor", "odour", "stink", "stench", "scent", "whiff", "reek", "sulfur", "sulphur");
const SULFUR_STEMS = F("sulfur", "sulphur");
const SULFUR_CONTEXT = new Set(F("furnace", "heater", "boiler", "stove", "oven", "pipe", "pipes", "line", "meter", "basement", "house", "home", "kitchen", "garage", "water"));
const EGG = new Set(F("egg", "eggs"));
const CO_WORDS = new Set(F("alarm", "alarms", "detector", "detectors", "alert", "sensor", "monitor", "poisoning", "poisoned", "reading", "levels", "beeping", "chirping", "going"));
const FLAME_TOKENS = new Set(F("fire", "fires", "flame", "flames", "flaming", "blaze", "blazing", "afire", "ablaze", "fuego", "fuegos", "incendio", "incendios"));
const SPANISH_SMOKE = new Set(F("humo", "humos"));
const BURN_STEMS = F("burn", "scorch", "melt", "smolder", "smoulder", "charr");
const BURN_CONTEXT = new Set(F("plastic", "rubber", "electrical", "wire", "wires", "wiring", "insulation", "dust", "metal"));
// an appliance or part that is itself burning
const BURNING_TOKENS = new Set(F("burning", "smoldering", "smouldering", "smolders", "smoulders", "scorching", "charring", "melting", "sizzling"));
const APPLIANCE = new Set(F("furnace", "heater", "boiler", "stove", "oven", "dryer", "unit", "system", "hvac", "thermostat", "fireplace", "chimney", "wall", "outlet", "panel", "wiring", "wires", "wire", "ac", "compressor", "motor", "blower", "duct", "ducts", "vent", "vents"));
const SPARK_STEMS = F("spark", "arcing", "arced", "zapp", "chispa");
const SHOCK_STEMS = F("shock");
const FLOOD_STEMS = F("flood", "submerg", "underwater", "inundat", "pouring", "gushing", "geyser");
const WET_STEMS = F("leak", "drip", "spray", "splash", "soak", "burst", "pour");
const WATERISH = new Set(F("water", "pipe", "pipes", "condensate", "ceiling", "roof", "drain", "flood", "rain"));
const ELEC_STEMS = F("electr", "breaker", "panel", "fuse", "fusebox", "outlet", "wiring", "wires", "socket", "circuit", "meter");
const ELEC_STRONG = F("electr", "breaker", "fuse", "fusebox", "outlet", "wiring", "socket", "circuit");
// Real words one typo away from "fire" / "sparks" that must not be read as typos.
const FIRE_WORDS = new Set(F("fir", "fie", "fare", "fore", "fife", "file", "fine", "five", "firm", "firs", "fibre", "fired", "free"));
const SPARK_WORDS = new Set(F("spars", "sparks"));
// "fire" / "smoke" followed by these is commercial building-code vocabulary, not a fire: "fire damper", "smoke control dampers", "fire-rated".
const NEUTRAL_NEXT = new Set(F("damper", "dampers", "rated", "rating", "code", "codes", "marshal", "marshall", "sprinkler", "sprinklers", "suppression", "protection", "door", "doors", "barrier", "barriers", "curtain", "curtains", "stop", "stopping"));
const CONTROL = fold("control");
const NEUTRAL_AFTER_CONTROL = new Set(F("damper", "dampers", "system", "systems"));

const starts = (tok, stems) => stems.some((s) => tok.startsWith(s));
const near = (tokens, i, pred, win) => {
  for (let j = Math.max(0, i - win); j <= Math.min(tokens.length - 1, i + win); j++) if (j !== i && pred(tokens[j])) return true;
  return false;
};
const isMonoxide = (t) => t.length >= 6 && (t === fold("monoxide") || levenshtein(t, fold("monoxide"), 2) <= 2);
const isCarbon = (t) => t.length >= 4 && (t === fold("carbon") || levenshtein(t, fold("carbon"), 1) <= 1);
const neutralContext = (tokens, i) => NEUTRAL_NEXT.has(tokens[i + 1]) || (tokens[i + 1] === CONTROL && NEUTRAL_AFTER_CONTROL.has(tokens[i + 2]));
// an adjacent swap: "fier" is "fire" with two letters exchanged
const transposed = (a, b) => {
  if (a.length !== b.length) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i < a.length - 1 && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
};
const typoOf = (t, word) => levenshtein(t, word, 1) <= 1 || transposed(t, word);

// Returns { emergency: boolean, reasons: string[] } with reason codes only (no text echoed).
export function detectEmergency(text) {
  const tokens = foldedTokens(text);
  const squashed = tokens.join("");
  const reasons = new Set();

  tokens.forEach((t, i) => {
    // gas near a leak/smell/hiss word
    if (GAS.has(t) && near(tokens, i, (x) => starts(x, LEAKISH_STEMS), 8)) reasons.add("gas");
    // "I smell sulfur": the odour added to gas, even when the word gas is never typed
    if (starts(t, SULFUR_STEMS) && (near(tokens, i, (x) => starts(x, SMELL_STEMS), 8) || near(tokens, i, (x) => SULFUR_CONTEXT.has(x), 4))) reasons.add("gas");
    // "rotten egg(s)" smell
    if (starts(t, F("rotten")) && near(tokens, i, (x) => EGG.has(x), 2) && tokens.some((x) => starts(x, SMELL_STEMS))) reasons.add("gas");
    // carbon monoxide, including misspellings
    if (isMonoxide(t)) reasons.add("carbon_monoxide");
    if (isCarbon(t) && near(tokens, i, isMonoxide, 2)) reasons.add("carbon_monoxide");
    if (t === "co" && near(tokens, i, (x) => CO_WORDS.has(x), 3)) reasons.add("carbon_monoxide");
    // smoke (not "smoker"), including typos and Spanish
    const neutral = neutralContext(tokens, i);
    if (!neutral) {
      if (t.startsWith("smok") && !t.startsWith("smoker")) reasons.add("smoke");
      if (t.length >= 4 && t.length <= 6 && t[0] === "s" && t[1] === "m" && !t.startsWith("smoker") && typoOf(t, "smoke")) reasons.add("smoke");
      // fire / flames, including one-typo spellings of "fire"
      if (FLAME_TOKENS.has(t)) reasons.add("fire");
      if (t.length >= 4 && t.length <= 5 && !FIRE_WORDS.has(t) && (t[0] === "f" ? typoOf(t, "fire") : transposed(t, "fire"))) reasons.add("fire");
    }
    if (SPANISH_SMOKE.has(t)) reasons.add("smoke");
    // burning smell
    if (starts(t, BURN_STEMS) && near(tokens, i, (x) => starts(x, SMELL_STEMS) || BURN_CONTEXT.has(x), 6)) reasons.add("burning_smell");
    if (starts(t, SMELL_STEMS) && near(tokens, i, (x) => starts(x, BURN_STEMS), 6)) reasons.add("burning_smell");
    // an appliance or part that is burning or smoldering
    if (BURNING_TOKENS.has(t) && near(tokens, i, (x) => APPLIANCE.has(x), 5)) reasons.add("burning_appliance");
    // sparks / arcing, including a misspelled "sparks"
    if (starts(t, SPARK_STEMS) && !starts(t, F("sparkling"))) reasons.add("sparks");
    if (t.length >= 5 && t.length <= 7 && t.startsWith("sp") && !SPARK_WORDS.has(t) && levenshtein(t, "sparks", 1) <= 1) reasons.add("sparks");
    // an electric shock (not "I was shocked by the price")
    if (starts(t, SHOCK_STEMS) && near(tokens, i, (x) => starts(x, ELEC_STEMS), 6)) reasons.add("sparks");
    // flooding near electrics
    if (starts(t, FLOOD_STEMS) && near(tokens, i, (x) => starts(x, ELEC_STEMS), 10)) reasons.add("flooding_electrical");
    if (starts(t, ELEC_STEMS) && near(tokens, i, (x) => starts(x, FLOOD_STEMS), 10)) reasons.add("flooding_electrical");
    // water leaking, dripping or spraying into electrics
    if (starts(t, WET_STEMS) && near(tokens, i, (x) => starts(x, ELEC_STRONG) || x === "panel", 6) && tokens.some((x) => WATERISH.has(x))) reasons.add("flooding_electrical");
  });

  // Letters spaced or punctuated apart: "g a s l e a k", "carbon-mon-oxide", "c.o. alarm".
  if (/(gas|propane)(leak|lek|smel|odor|escap)|(leak|lek|smel|odor)(ing|s|of|from|like)?(gas|propane)/.test(squashed)) reasons.add("gas");
  if (/monoxide|monoxid|carbonmon/.test(squashed)) reasons.add("carbon_monoxide");
  if (/coalarm|codetector|coalert/.test(squashed)) reasons.add("carbon_monoxide");

  const folded = foldForSafety(text);
  if (/\b(on|caught|catching) fire\b|\bhouse fire\b/.test(folded)) reasons.add("fire");

  return { emergency: reasons.size > 0, reasons: [...reasons].sort() };
}

// Used when the owner has not supplied catalog.emergencyGuidance. Needs owner approval before launch.
export const DEFAULT_EMERGENCY_GUIDANCE =
  "This may be an emergency. Leave the building now. Do not use light switches, open flames or phones inside. " +
  "From outside, call 911, or your gas utility's emergency line if you smelled gas. " +
  "This chat is not an emergency line and a person may not see it right away.";

export const EMERGENCY_HANDOFF_OFFER =
  "Once you are safe, if you would like our team to follow up, send your phone number and ZIP code and I can prepare a callback request for you to confirm. " +
  "If there is no danger, tell me what you need and we can continue.";

const guidanceText = (catalog) => (typeof catalog?.emergencyGuidance === "string" && catalog.emergencyGuidance.trim() ? catalog.emergencyGuidance.trim() : DEFAULT_EMERGENCY_GUIDANCE);

export function emergencyReply(catalog) {
  return `${guidanceText(catalog)}\n\n${EMERGENCY_HANDOFF_OFFER}`;
}

// For a conversation that can no longer take messages (expired or out of turns): the guidance, without an offer it cannot keep.
export function emergencyClosedReply(catalog) {
  return `${guidanceText(catalog)}\n\nThis conversation can't take more messages. Once you are safe, start a new chat if you would like our team to follow up.`;
}
