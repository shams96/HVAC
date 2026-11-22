// A9: deterministic scope pre-check. Best-effort first line of defence; the output guard and tool
// allowlist hold even when this misses something.
import { cleanText } from "./text.mjs";
import { foldHomoglyphs } from "./lookalike.mjs";

const LANGS = "python|javascript|typescript|java|c\\+\\+|c#|golang|rust|php|ruby|sql|html|css|bash|powershell|regex|exploit|malware|shellcode";
const RULES = [
  ["prompt_probe", /\b(system|hidden|initial|original|secret|developer)\s+(prompt|instruction|message|rules?)s?\b|\byour\s+(instructions|rules|prompt|guidelines|programming|configuration)\b|\bignore\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding)\b|\bdisregard\s+.{0,30}\b(instructions|rules|prompt)\b|\b(reveal|show|print|repeat|leak)\s+.{0,30}\b(prompt|instructions)\b|\bdeveloper mode\b|\bjailbreak\b|\bdo anything now\b|\byou are now\b|\bpretend (to be|you are|you're)\b|\brepeat\s+(?:the\s+|all\s+|everything\s+)?(?:words|text|everything)\s+(?:above|before)\b|\bwhat\s+(?:were|are)\s+you\s+(?:told|instructed|given|programmed)\b|\bbefore\s+this\s+(?:conversation|chat)\b|\bstarting\s+with\s+['"]?you\s+are\b|\bquote\s+(?:it\s+)?verbatim\b/i],
  ["code", new RegExp(`\\b(write|generate|give me|show me|debug|create|code)\\b.{0,40}\\b(?<!(?:error|fault|promo|promotion|discount|zip|area|postal|building|access|door|gate|alarm|status|diagnostic|trouble|display|blink)\\s)(code|script|${LANGS})\\b|\\b(write|generate|create|build)\\b.{0,30}\\b(function|program|script|app|bot|class)\\b.{0,25}\\b(in|using|with)\\s+(${LANGS})\\b|\`\`\``, "i")],
  ["legal", /\b(legal advice|lawsuit|sue\b|suing|attorney|lawyer|liable|liability claim|legally (required|obligated|allowed)|my rights)\b/i],
  ["medical", /\b(medical advice|medication|prescription|dosage|my (symptoms|headache|cough|asthma)|am i (sick|poisoned)|should i see a doctor)\b/i],
  ["discount", /\b(discounts?|coupons?|promo(tion(al)?)?( code)?|price[- ]match|beat (any|their|another|that)|match (their|any|that) (price|quote)|waive|half[- ]price|price break|best price|haggle|negotiate)\b|\bcan you (do|fix|install|repair|replace)\b.{0,40}\bfor (\$\s?\d|\d[\d,.]*\s*(dollars|bucks|usd)\b)/i],
  ["other_business", /\b(recommend|suggest|refer|compare)\b.{0,40}\b(another|other|different|competitor|competing|better)\b.{0,30}\b(company|contractor|business|plumber|hvac|electrician|provider)\b|\bcompetitors?\b/i],
  ["arrival_promise", /\b(promise|guarantee|swear|assure|commit)\b.{0,50}\b(arriv[a-z]*|be here|be there|show up|come|get here|on time)\b|\b(exact|specific)\s+(arrival|eta|time of arrival|arrival time)\b|\bwhat time (exactly|precisely)\b/i],
  ["general_chat", /\b(tell me a joke|write (me )?(a )?(poem|song|story|essay|haiku)|who (is|was) the (president|prime minister)|weather (forecast|today)|recipe for|translate (this|the following)|homework|stock tips?|bitcoin|crypto(currency)?|lottery|sports scores?|what is the meaning of life)\b/i],
];

// Returns { outOfScope: boolean, category?: string }.
export function checkScope(text) {
  // Cyrillic / Greek look-alike letters are read as the Latin letters they imitate ("prоmpt").
  const t = foldHomoglyphs(cleanText(text).normalize("NFKC"));
  for (const [category, re] of RULES) if (re.test(t)) return { outOfScope: true, category };
  return { outOfScope: false };
}

export const SCOPE_REFUSAL =
  "I can't help with that here. I can answer questions about our services and service areas, and help you request an estimate. " +
  "If you would like, I can prepare a request for a team member to contact you.";
