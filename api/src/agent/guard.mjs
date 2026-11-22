// A6 / A1: output guard. Whatever the model writes, a reply that breaks a rule here never reaches the customer.
// Returns { ok, text, reasons } where reasons are codes only. On failure the caller substitutes SAFE_FALLBACK.
import { amountsApproved, approvedAmounts } from "../catalog.mjs";
import { cleanText } from "./text.mjs";
import { asciiDigits, bannedClaimHit, phoneCandidates, foldHomoglyphs, stripMarks } from "./lookalike.mjs";

export const SAFE_FALLBACK =
  "I can't state that reliably. A member of our team will confirm the details. If you would like, I can prepare a request for staff to contact you.";

const MAX_REPLY = 1500;
const NUMBER_WORDS = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|grand|dozen";
const NUM = "[0-9][0-9,]*(?:\\.[0-9]+)?";
const SYMBOLS = "€£¥₹₩₽₺₫₪₴฿₦₱";
const CODES = "usd|us\\$|cad|aud|nzd|eur|gbp|chf|mxn|inr|jpy|cny|rmb|krw";
const CURRENCY_WORDS = "dollars?|bucks?|usd|smackers|greenbacks?|bux|euros?|eur|gbp|cad|aud|nzd|chf|mxn|inr|jpy|cny|rmb|krw|pesos?|rupees?|yen|yuan|francs?|pounds?|quid";
const US_MONEY_WORDS = /^(?:dollars?|bucks?|usd|smackers|greenbacks?|bux)$/i;
const US_ADJECTIVE = /^(?:u\.?s\.?|american)\s*$/i;
const PRICE_WORDS = "price|prices|pricing|priced|cost|costs|costing|fee|fees|charge|charges|charged|rate|rates|quote|quoted|total|deposit|payment|pay|pays|paying|owe|fare|diagnostic";
const NOT_PRICE_UNITS = "percent|am|pm|a\\.m|p\\.m|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|yrs?|miles?|feet|ft|inch|inches|sq|seer|btu|tons?|degrees?|units?|rooms?|floors?|zones?|systems?|people|techs?|technicians?|stars?|st|nd|rd|th|x";

const negated = (text, index) => /(nothing|can'?t|cannot|can not|won'?t|will not|not|n't|unable|never|no|without|don'?t|do not)\s+(\w+\s+){0,3}$/i.test(text.slice(Math.max(0, index - 40), index));

// A price written as a bare number next to a price word or a rate word ("fee is 99 flat", "150 an hour").
export function bareNumberPrice(text, catalog) {
  const ok = approvedAmounts(catalog);
  const zips = new Set((catalog?.areas ?? []).map((a) => a.zip));
  const masked = text
    .replace(/\+?\d[\d\s().-]{8,}\d/g, " # ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " # ")
    .replace(/\b\d{1,2}[:/]\d{2}\b/g, " # ")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, " # ");
  const skip = (raw) => {
    const v = Number(raw.replace(/,/g, ""));
    return !(v >= 10) || ok.has(v) || zips.has(raw) || /^(?:19|20)\d{2}$/.test(raw);
  };
  const afterPriceWord = new RegExp(`\\b(?:${PRICE_WORDS})\\b[^.!?\\n]{0,40}?(?<![\\w$.,:/-])(${NUM})(?![0-9])(?!\\s*%)(?!\\s*(?:${NOT_PRICE_UNITS})\\b)`, "gi");
  for (const m of masked.matchAll(afterPriceWord)) if (!skip(m[1])) return true;
  const rateForm = new RegExp(`(?<![\\w$.,:/-])(${NUM})\\s*(?:flat\\b|apiece\\b|each\\b|per\\s+(?:visit|hour|hr|call|job|trip|service|unit|system|ton|month|mo|year|yr)\\b|an?\\s+(?:hour|visit|month|year|call|trip)\\b|/\\s*(?:hr|hour|visit|mo|month|yr|year)\\b)`, "gi");
  for (const m of masked.matchAll(rateForm)) if (!skip(m[1])) return true;
  return false;
}

// Prices the model has no way of knowing: anything that is not a plain owner-approved USD amount.
function priceViolation(text, catalog) {
  if (!amountsApproved(text, catalog)) return true;
  // Multipliers ("$129k"), other currencies, prefix codes, words for numbers and trailing symbols are all unapproved.
  if (/\$\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:k|m|thousand|million|grand|bn|b)\b/i.test(text)) return true;
  if (/[0-9]\s*(?:k|m)\s*(?:dollars?|usd|bucks|\$)/i.test(text)) return true;
  if (new RegExp(`[${SYMBOLS}]\\s*[0-9]|[0-9]\\s*[${SYMBOLS}]`).test(text)) return true;
  if (new RegExp(`\\b(?:${CODES})\\s*[:=]?\\s*\\$?\\s*[0-9]`, "i").test(text)) return true;
  if (/[0-9]\s*\$/.test(text)) return true;
  // A number followed by a currency word, with up to two words between ("99 US dollars", "99 Canadian dollars", "99 euros").
  for (const m of text.matchAll(new RegExp(`(?<![0-9.,])${NUM}[\\s-]*((?:[a-z.]+\\s+){0,2}?)(${CURRENCY_WORDS})\\b`, "gi"))) {
    if (US_MONEY_WORDS.test(m[2]) && (m[1].trim() === "" || US_ADJECTIVE.test(m[1]))) continue; // plain USD: approved above
    return true;
  }
  if (new RegExp(`\\b(?:${NUMBER_WORDS})\\b(?:[\\s-]+[a-z]+){0,4}?[\\s-]+(?:${CURRENCY_WORDS})\\b`, "i").test(text)) return true;
  if (new RegExp(`\\b(?:a|one|couple|few)\\s+(?:hundred|thousand|grand)\\b`, "i").test(text) && /\b(dollars?|bucks|price|cost|charge|fee|\$)\b/i.test(text)) return true;
  return bareNumberPrice(text, catalog);
}

// Arrival or dispatch promises, however they are phrased. Negated forms ("I can't promise same-day service") pass.
const WHEN = "today|tonight|tomorrow|this (?:morning|afternoon|evening)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|noon|midnight|asap|right away|immediately|first thing|in the morning|within|by \\d|at \\d|around \\d|now";
const ARRIVAL = [
  /\b(will|'ll|shall|going to|gonna|can)\s+(be|arrive|come|show up|get)\b[^.!?\n]{0,40}\b(today|tonight|tomorrow|this (morning|afternoon|evening)|within|by|at|in)\s+(an?\s+|the\s+|\d)/i,
  /\b(technician|tech|someone|crew|team|we|driver)\b[^.!?\n]{0,30}\b(will|'ll)\s+(arrive|be there|be at your|be out|get there|show up|be on site)\b[^.!?\n]{0,50}\b(today|tonight|tomorrow|within|by|at|\d|same[- ]day)/i,
  /\b(same[- ]day|next[- ]day) (service|arrival|appointment) (is )?guaranteed\b/i,
  /\b(arrive|arrival|be there|be here|get there)\b[^.!?\n]{0,25}\b(within|in under|in less than)\s+\d+\s*(minutes?|mins?|hours?|hrs?)\b/i,
];
const ARRIVAL_LOOSE = [
  new RegExp(`\\b(?:expect|see)\\s+(?:us|you|him|her|them|our\\s+(?:tech|technician|team|crew))\\b[^.!?\\n]{0,40}\\b(?:${WHEN})`, "i"),
  new RegExp(`\\bsee you\\b[^.!?\\n]{0,30}\\b(?:${WHEN})`, "i"),
  /\bat your (?:door|doorstep)\b/i,
  /\b(?:technician|tech|techs|technicians|someone|somebody|crew|team|driver|we|he|she|they)(?:\s+(?:is|are)|'s|'re)\s+(?:\w+\s+)?(?:coming|heading|headed|on (?:the|their|its) way|en route|rolling|driving|dispatched|on (?:the )?road|on site)\b/i,
  /\bheading out to you\b|\bheaded your way\b|\bon (?:the|our|their) way to you\b/i,
  /\beta\b/i,
  new RegExp(`\\b(?:we'll|we will|i'll|i will|we can|we're going to)\\s+(?:have|get|send|put)\\s+(?:a|an|our|the|someone|somebody|you)\\b[^.!?\\n]{0,30}\\b(?:out|over|there|to you|to your)\\b[^.!?\\n]{0,40}\\b(?:${WHEN})`, "i"),
  /\b(?:promise|promises|promised|assure|assured|swear|commit|committed)\b[^.!?\n]{0,30}\b(?:same[- ]day|next[- ]day|on[- ]time|arriv\w+|by \d|within \d)/i,
  /\b(?:will|'ll)\s+(?:pull|show|roll|turn)\s+up\b/i,
  /\bsame[- ]day\s+(?:service|appointment|arrival|repair|visit|response)\b/i,
];
const GUARANTEE = /\bguarantee(?:s|d)?\b/gi;

// Claims that a state change already happened. Only /api/chat/confirm can make that true, and its text is not model text.
const RECORDS = "request|inquiry|enquiry|message|details|info|information|form|booking|appointment|estimate|order|ticket|case|slot|visit";
const COMPLETED = [
  /\b(have|has|had|is|are|was|were|been|now|successfully|already|just|'ve|'s|'re)\s+(been\s+)?(booked|scheduled|confirmed|submitted|dispatched|sent|created|placed|arranged|reserved|filed|logged|registered|received)\b/i,
  /\b(you(?:'re| are)|you(?:'ve| have)|it(?:'s| is)|that(?:'s| is)|all)\s+(now\s+)?(all set|set|booked|confirmed|scheduled|good to go)\b/i,
  /\bi\s+(hereby\s+)?(confirm|book|booked|schedule|scheduled|submit|submitted|dispatch|dispatched|approve|approved)\b(?!\s+(?:that\s+)?(?:you|this|it)\s+(?:can|could|may|might))/i,
  /\bi(?:'ve| have)\s+(sent|booked|scheduled|submitted|dispatched|created|placed|arranged|reserved|notified|emailed|texted|called)\b/i,
  /\b(technician|tech|crew|team|someone)\s+(is|are)\s+(on\s+(the|their|its)\s+way|en route|headed|dispatched)\b/i,
  /\bconfirmation\s+(number|code|id)\b/i,
  /\b(?:i|we)(?:'ve|\s+have|\s+had)?\s+(?:just\s+|already\s+)?(?:(?:went|gone)\s+ahead\s+and\s+)?(?:forwarded|passed|relayed|escalated|routed|queued|set\s+up|put\s+you|signed\s+you|added\s+you|got\s+you|reserved|held|locked|secured|assigned|dispatched|sent|booked|scheduled|submitted|arranged|created|placed|notified|emailed|texted|called|filed|registered|logged)\b/i,
  /\bconsider it (?:done|booked|handled|sorted)\b/i,
  new RegExp(`\\b(?:${RECORDS})\\s+(?:received|logged|recorded|submitted)\\b`, "i"),
  new RegExp(`\\b(?:${RECORDS})\\s+(?:has|have|is|was|are|were)\\s+(?:now\\s+)?(?:been\\s+)?(?:received|forwarded|submitted|sent|logged|recorded|locked(?:\\s+in)?|held|reserved|assigned|passed|on\\s+its\\s+way|on\\s+the\\s+way|in\\s+the\\s+system|booked|scheduled|confirmed|saved|secured|blocked)\\b`, "i"),
  /\b(?:technician|tech|dispatcher|crew|team|office|staff|someone)\s+(?:has|have)\s+(?:already\s+)?been\s+(?:assigned|dispatched|notified|alerted|scheduled|booked|confirmed|sent)\b/i,
  /\b(?:dispatcher|team|office|staff|someone|we)\s+(?:now\s+|already\s+)?(?:has|have)\s+(?:got\s+)?(?:all\s+)?your\s+(?:details|info|information|request|number|contact|booking|appointment|message)\b/i,
  /\bgot you (?:down|booked|scheduled|set|signed|on the (?:schedule|calendar|books))\b/i,
  /\b(?:slot|spot|time|appointment|booking|visit)\s+(?:is|was|has been|have been)\s+(?:held|reserved|locked|secured|saved|blocked|penciled)\b/i,
];

// Coverage talk: any phrasing that tells the customer an area or service is covered.
const COVERAGE_CLAIMS = [
  /\b(we|our team|our technicians?)\s+(do\s+|also\s+)?(serve|service|cover|come to|travel to|work in|operate in)\b/i,
  /\bwithin our (service )?(area|coverage|range)\b|\bin our (service )?(area|coverage|range|zone|region)\b|\bour service area (includes|covers)\b|\bavailable in\b|\bwe(?:'re| are) available\b/i,
  /\byou(?:'re| are)\s+(?:all\s+)?(?:covered|within|in our|in the area)\b|\b(?:zip|area|address|location|city|neighbou?rhood|town|that)\b[^.!?\n]{0,20}\b(?:is|are)\s+covered\b/i,
  /\b[Ww]e\s+(?:can|could|will|do|are able to|'re able to)\s+(?:definitely\s+|absolutely\s+|certainly\s+|gladly\s+|happily\s+)*(?:help|assist|serve|service|come|get|reach)\b[^.!?\n]{0,25}\b(?:in|to|near|around|at)\s+[A-Z]/,
];
const COVERAGE_HEDGE = /\b(not listed|isn'?t listed|aren'?t listed|not sure|can'?t confirm|cannot confirm|staff will confirm|team will confirm|will confirm)\b/i;
const NEGATIVE_SENTENCE = /n't\b|\b(?:not|no|never|cannot|unable|unfortunately|only|except|without)\b/i;
const squashLetters = (s) => s.toLowerCase().replace(/[^a-z]/g, "");

// A listed ZIP (or city) named in the same sentence as a catalog service the catalog does not list for it.
function serviceZipViolation(text, catalog) {
  const areas = catalog?.areas ?? [];
  const services = catalog?.services ?? [];
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    if (NEGATIVE_SENTENCE.test(sentence) || COVERAGE_HEDGE.test(sentence)) continue;
    const lower = sentence.toLowerCase();
    const zips = new Set(sentence.match(/\b\d{5}\b/g) ?? []);
    const named = areas.filter((a) => zips.has(a.zip) || (a.city && lower.includes(String(a.city).toLowerCase())));
    if (!named.length) continue;
    const sq = squashLetters(sentence);
    for (const a of named) {
      for (const s of services) {
        if ((a.serviceLines ?? []).includes(s.slug)) continue;
        const keys = [squashLetters(s.slug), squashLetters(s.name ?? "")];
        if (keys.some((k) => k.length >= 4 && sq.includes(k))) return true;
      }
    }
  }
  return false;
}

const GRANTS_DISCOUNT = [
  /\b\d{1,3}\s*%\s*(off|discount)\b/i,
  /\b(we|i)(?:'ll| will| can)?\s+(give|offer|apply|honou?r|match|waive|take|knock)\s+(you\s+)?(a\s+|an\s+|the\s+|your\s+)?(\d+\s*%|discount|coupon|promo|price match|free\s+(service|repair|install|tune|visit|diagnostic))/i,
  /\b(promo(tion)?|coupon) code\b/i,
  new RegExp(`\\$\\s*${NUM}\\s*(?:off|credit|rebate|discount|coupon|voucher|back|savings?|toward|towards)\\b`, "i"),
  new RegExp(`(?<![0-9.,])${NUM}\\s*(?:%|percent|per\\s*cent|pct)\\s*(?:off|discount|savings?|rebate|credit)\\b`, "i"),
  new RegExp(`\\b(?:${NUMBER_WORDS})(?:[\\s-]+(?:${NUMBER_WORDS}))*[\\s-]*(?:%|percent|per\\s*cent)\\s*(?:off|discount|savings?|rebate)\\b`, "i"),
  /\b(?:half|quarter|third)[\s-]*(?:off|price)\b/i,
  /\b(?:buy one,? get one|bogo|two[\s-]for[\s-]one|2[\s-]for[\s-]1|b1g1)\b/i,
  new RegExp(`\\b(?:save|saves|saving|savings|knock|knocks|take|takes|slash|slashes|shave|shaves)\\b[^.!?\\n]{0,12}(?:\\$\\s*${NUM}|${NUM}\\s*(?:%|percent|dollars?|bucks))`, "i"),
];

// "free of charge", "on the house" and the like. A free ESTIMATE is a catalog fact and idioms such as "feel free" are not offers.
const FREE_WORD = /\b(?:free of charge|free|complimentary|gratis|no[- ](?:cost|charge)|at no (?:extra |additional )?(?:cost|charge)|on the house|zero[- ]cost)\b|\$\s*0(?:\.00)?(?![0-9])/gi;
function freeOffer(text) {
  const stripped = text
    .replace(/\b(?:free|complimentary|no[- ](?:cost|charge))[\s-]+(?:[a-z-]+\s+){0,2}?(?:estimates?|quotes?|consultations?|assessments?)\b/gi, " ")
    .replace(/\b(?:estimates?|quotes?|consultations?)\b[^.!?\n]{0,25}?\b(?:are|is|come|comes|will be|always|remain|remains)\s+(?:\w+\s+){0,2}?(?:free of charge|free|complimentary|no[- ](?:cost|charge))\b/gi, " ")
    .replace(/\b(?:feel free|free to|toll[- ]free|free (?:from|up|time)|free of (?!charge))|\b[a-z]+-free\b/gi, " ");
  for (const m of stripped.matchAll(FREE_WORD)) if (!negated(stripped, m.index)) return true;
  return false;
}

const digitsOnly = (s) => s.replace(/\D/g, "");

// Does the reply reproduce a run of the system prompt?
function leaksPrompt(text, system) {
  if (typeof system !== "string" || system.length < 80) return false;
  const norm = (s) => foldHomoglyphs(stripMarks(s)).replace(/[^a-z0-9]+/g, " ").trim();
  const p = norm(system);
  const r = norm(text);
  for (let i = 0; i + 48 <= p.length; i += 16) if (r.includes(p.slice(i, i + 48))) return true;
  return false;
}

function linkViolation(text, bookingHost) {
  const t = text.replace(/\s*(?:\[\s*\.\s*\]|\(\s*\.\s*\)|\[\s*dot\s*\]|\(\s*dot\s*\))\s*/gi, ".");
  if (/\b(?:javascript|vbscript|data|file):/i.test(t)) return true;
  const hostOf = (raw) => {
    try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase(); } catch { return raw.toLowerCase(); }
  };
  const emails = /[A-Za-z0-9._%+'-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24})/g;
  for (const m of t.matchAll(emails)) if (m[1].toLowerCase() !== bookingHost) return true;
  const rest = t.replace(emails, " ");
  const urlish = /\b(?:(?:https?|hxxps?|ftp|sftp|wss?):\/\/|www\.)[^\s<>"')]+|(?<![A-Za-z0-9-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[a-z]{2,24}(?![A-Za-z0-9-])(?::\d{1,5})?(?:\/[^\s<>"')]*)?/g;
  for (const m of rest.matchAll(urlish)) if (hostOf(m[0]) !== bookingHost) return true;
  return false;
}

export function guardReply(rawText, { catalog, userTexts = [], coverageVerified = false, coverageChecks = null, system = null } = {}) {
  const reasons = [];
  let text = asciiDigits(cleanText(rawText).normalize("NFKC")).replace(/\u{1F4B2}/gu, "$").replace(/⃣/g, "");
  if (!text) return { ok: false, text: SAFE_FALLBACK, reasons: ["empty"] };
  // Plain text only: the widget must never receive markup.
  const stripped = text.replace(/<[^>]*>/g, "").replace(/<(?=[a-z/!])/gi, "");
  if (stripped !== text) { reasons.push("markup"); text = stripped; }
  if (text.length > MAX_REPLY) text = `${text.slice(0, MAX_REPLY)}...`;

  if (priceViolation(text, catalog)) reasons.push("unapproved_price");

  if (bannedClaimHit(text, catalog?.bannedClaims)) reasons.push("banned_claim");
  if (leaksPrompt(text, system)) reasons.push("prompt_leak");

  if (ARRIVAL.some((re) => re.test(text))) reasons.push("arrival_promise");
  else {
    for (const re of ARRIVAL_LOOSE) {
      const m = re.exec(text);
      if (m && !negated(text, m.index)) { reasons.push("arrival_promise"); break; }
    }
  }
  for (const m of text.matchAll(GUARANTEE)) if (!negated(text, m.index)) { reasons.push("guarantee"); break; }

  for (const re of COMPLETED) {
    const m = re.exec(text);
    if (m && !negated(text, m.index)) { reasons.push("claims_completed_action"); break; }
  }

  if (GRANTS_DISCOUNT.some((re) => re.test(text)) || freeOffer(text)) reasons.push("discount_offer");

  // Phone numbers: only the catalog's, or one the customer typed themselves, in any disguise.
  const allowed10 = new Set();
  const allowed7 = new Set();
  const own = catalog?.business?.phoneE164 ?? catalog?.business?.phoneDisplay;
  if (own) allowed10.add(digitsOnly(own).slice(-10));
  for (const u of userTexts) {
    for (const alts of phoneCandidates(u)) for (const d of alts) (d.length === 7 ? allowed7 : allowed10).add(d.length === 7 ? d : d.slice(-10));
  }
  const phoneOk = (d) => (d.length === 7 ? allowed7.has(d) || [...allowed10].some((a) => a.endsWith(d)) : allowed10.has(d.slice(-10)));
  if (phoneCandidates(text).some((alts) => !alts.some(phoneOk))) reasons.push("unknown_phone");

  // Links: only the catalog booking URL's host.
  let bookingHost = null;
  try { bookingHost = catalog?.business?.bookingUrl ? new URL(catalog.business.bookingUrl).hostname.toLowerCase() : null; } catch { /* no booking URL */ }
  if (linkViolation(text, bookingHost)) reasons.push("unapproved_link");

  // Coverage is decided by catalog.areas and by the ZIP the customer actually asked about, never by model text.
  const areaZips = new Set((catalog?.areas ?? []).map((a) => a.zip));
  if (COVERAGE_CLAIMS.some((re) => re.test(text)) && !COVERAGE_HEDGE.test(text)) {
    if (!coverageVerified) reasons.push("unlisted_coverage_claim"); // no check_coverage result backs this claim
    else {
      const verified = Array.isArray(coverageChecks) ? new Set(coverageChecks.filter((c) => c.listed && c.serviceOffered !== false).map((c) => c.zip)) : null;
      const mentioned = text.match(/\b\d{5}\b/g) ?? [];
      let bad = mentioned.some((z) => !areaZips.has(z) || (verified && !verified.has(z)));
      if (!bad && verified && !mentioned.length) {
        let asked = [];
        for (let i = userTexts.length - 1; i >= 0 && !asked.length; i--) asked = asnZips(userTexts[i]);
        bad = asked.some((z) => !verified.has(z));
      }
      if (bad) reasons.push("unlisted_coverage_claim");
    }
  }
  if (serviceZipViolation(text, catalog) && !reasons.includes("unlisted_coverage_claim")) reasons.push("unlisted_coverage_claim");

  if (reasons.some((r) => r !== "markup")) return { ok: false, text: SAFE_FALLBACK, reasons: [...new Set(reasons)] };
  return { ok: true, text, reasons };
}

const asnZips = (s) => asciiDigits(String(s ?? "").normalize("NFKC")).match(/(?<![0-9])\d{5}(?![0-9])/g) ?? [];
