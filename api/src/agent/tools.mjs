// A7: the tool allowlist. Read tools return catalog / provider facts. Proposal tools only INSERT a pending_actions row.
// Nothing here executes a state change; execution lives in agent.mjs confirm() and is reachable only from /api/chat/confirm.
import { randomUUID } from "node:crypto";
import { normalizePhone, normalizeEmail } from "../domain/phone.mjs";
import { cleanText } from "./text.mjs";
import { logAction } from "./log.mjs";
import { guardReply } from "./guard.mjs";

export const MAX_PENDING_PER_CONVERSATION = 3;
const SLUG = /^[a-z0-9-]{1,64}$/;
const ZIP = /^[0-9]{5}$/;
// Slots must be ISO-8601 instants or start/end ranges; anything else from a provider is dropped, not cleaned.
const ISO = "[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:[.][0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?";
const SLOT_RE = new RegExp(`^${ISO}(?:/${ISO})?$`);

// ---- minimal argument validator (no dependency); unknown keys are rejected ----
function validate(schema, args) {
  const problems = [];
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return { ok: false, problems: ["arguments must be an object"] };
  const value = {};
  for (const k of Object.keys(args)) if (!Object.hasOwn(schema.properties, k)) problems.push(`${k.replace(/[^A-Za-z0-9_]/g, "").slice(0, 32) || "?"}: not an allowed argument`);
  for (const r of schema.required ?? []) if (args[r] === undefined || args[r] === null || args[r] === "") problems.push(`${r}: required`);
  for (const [k, def] of Object.entries(schema.properties)) {
    let v = args[k];
    if (v === undefined || v === null) continue;
    if (def.type === "boolean") {
      if (typeof v !== "boolean") problems.push(`${k}: must be true or false`); else value[k] = v;
      continue;
    }
    if (typeof v !== "string") { problems.push(`${k}: must be text`); continue; }
    v = cleanText(v);
    if (def.maxLength && v.length > def.maxLength) { problems.push(`${k}: too long (max ${def.maxLength})`); continue; }
    if (def.enum && !def.enum.includes(v)) { problems.push(`${k}: must be one of ${def.enum.join(", ")}`); continue; }
    if (def.pattern && !def.pattern.test(v)) { problems.push(`${k}: wrong format`); continue; }
    if (v === "" && (schema.required ?? []).includes(k)) { problems.push(`${k}: required`); continue; }
    value[k] = v;
  }
  return problems.length ? { ok: false, problems } : { ok: true, value };
}

const S = (maxLength, extra = {}) => ({ type: "string", maxLength, ...extra });
const serviceLineProp = S(64, { pattern: SLUG, description: "A service slug returned by list_services." });
const zipProp = S(5, { pattern: ZIP, description: "5-digit US ZIP code." });

// ---- facts ----
const priceOf = (s) => (s.pricing?.kind === "approved" ? { price: `$${s.pricing.amount}`, currency: s.pricing.currency ?? "USD" } : { price: null, note: "Free estimate. No price is quoted in chat." });
const serviceByslug = (catalog, slug) => catalog.services.find((s) => s.slug === slug);

function cleanSlots(raw) {
  if (!raw || !Array.isArray(raw.slots)) return [];
  const out = [];
  for (const s of raw.slots.slice(0, 12)) {
    const text = typeof s === "string" ? s : s && typeof s === "object" ? [s.start, s.end].filter((x) => typeof x === "string").join("/") : "";
    if (text.length <= 64 && SLOT_RE.test(text)) out.push(text);
  }
  return out;
}

async function fetchSlots(ctx, { zip, serviceLine, window }) {
  if (!ctx.availability || typeof ctx.availability.check !== "function") return null;
  try {
    const r = await ctx.availability.check({ zip, serviceLine, ...(window ? { window } : {}) });
    if (!r || r.unavailable) return null;
    const slots = cleanSlots(r);
    return slots.length ? slots : null;
  } catch {
    return null;
  }
}

const STAFF_WILL_CONFIRM = "Staff will confirm availability.";

// Everything the model chose that ends up in a summary, a lead or an account is checked here, so what the customer confirms
// is what is stored and no model-chosen field is a side channel for prices, links, markup or promises.
const NAME_OK = /^[\p{L}][\p{L}\p{M}'’.\- ]{0,119}$/u;
const COMPANY_OK = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}&'’.,\- ]{0,159}$/u;
const EMAIL_OK = /^[a-z0-9._%+'-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/;
const showPhone = (e164) => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;

function guardedText(ctx, text, userTexts = []) {
  const g = guardReply(text, { catalog: ctx.catalog, userTexts });
  return g.ok ? g.text : null;
}

// Returns { error } when no usable contact exists, else the cleaned fields and the names of fields that were dropped.
function cleanContact(ctx, a) {
  const phone = normalizePhone(a.phone);
  const e = normalizeEmail(a.email);
  const email = e && EMAIL_OK.test(e) ? e : null;
  if (!phone && !email) return { error: { error: "need_contact", message: "A valid phone number or email is required. Ask the customer for one." } };
  const dropped = [];
  const fields = {};
  if (a.name) {
    const name = a.name.replace(/\s+/g, " ").trim();
    if (NAME_OK.test(name) && name.split(" ").length <= 8 && guardedText(ctx, name)) fields.name = name;
    else dropped.push("name");
  }
  if (phone) fields.phone = phone;
  else if (a.phone) dropped.push("phone");
  if (email) fields.email = email;
  else if (a.email) dropped.push("email");
  if (a.details) {
    const details = guardedText(ctx, a.details, [a.phone ?? "", a.email ?? ""]);
    if (details) fields.details = details;
    else dropped.push("details");
  }
  return { fields, dropped };
}

const contactBits = (f) => [f.name, f.phone && showPhone(f.phone), f.email].filter(Boolean).join(", ");
const noteBit = (f) => (f.details ? ` Note: ${f.details}` : "");

// ---- proposal helper: INSERT only ----
async function propose(ctx, kind, args, summary, dropped = []) {
  const r = await proposeRow(ctx, kind, args, summary);
  return dropped.length ? { ...r, dropped, note: `${r.note ?? ""} These fields were not usable and were left out: ${dropped.join(", ")}.` } : r;
}
async function proposeRow(ctx, kind, args, summary) {
  const nowIso = ctx.now().toISOString();
  const open = await ctx.db.query("SELECT id, args FROM pending_actions WHERE conversation_id = $1 AND status = 'pending' AND expires_at > $2::timestamptz AND kind = $3", [ctx.conversation.id, nowIso, kind]);
  const same = open.rows.find((r) => JSON.stringify(r.args) === JSON.stringify(args));
  if (same) return { status: "pending_customer_confirmation", note: PENDING_NOTE };
  const total = (await ctx.db.query("SELECT count(*)::int AS n FROM pending_actions WHERE conversation_id = $1 AND status = 'pending' AND expires_at > $2::timestamptz", [ctx.conversation.id, nowIso])).rows[0].n;
  if (total >= MAX_PENDING_PER_CONVERSATION) {
    await logAction(ctx.db, { at: nowIso, conversationId: ctx.conversation.id, actor: "agent", event: "blocked", data: { reason: "too_many_pending", kind } });
    return { error: "too_many_pending", message: "The customer already has pending requests to review. Ask them to confirm or reject those first." };
  }
  const id = randomUUID();
  const expires = new Date(ctx.now().getTime() + ctx.actionTtlMin * 60_000).toISOString();
  await ctx.db.query(
    `INSERT INTO pending_actions (id, conversation_id, kind, args, summary, status, created_at, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'pending', $6::timestamptz, $7::timestamptz)`,
    [id, ctx.conversation.id, kind, JSON.stringify(args), summary, nowIso, expires]
  );
  await logAction(ctx.db, { at: nowIso, conversationId: ctx.conversation.id, actionId: id, actor: "agent", event: "proposed", data: { kind } });
  ctx.proposals.push({ id, kind, summary, expiresAt: expires });
  return { status: "pending_customer_confirmation", note: PENDING_NOTE };
}
const PENDING_NOTE = "Nothing has been sent or booked. The customer must press Confirm in the chat window. Do not say it was sent, booked or confirmed.";

export const TOOLS = {
  get_business_info: {
    description: "Business name, phone, hours and booking link from the approved catalog.",
    schema: { properties: {} },
    async run(ctx) {
      const b = ctx.catalog.business ?? {};
      return { name: b.legalName ?? null, phone: b.phoneDisplay ?? null, hours: b.hours ?? null, bookingUrl: b.bookingUrl ?? null };
    },
  },
  list_services: {
    description: "Every service in the approved catalog with its slug, summary and approved price (if any).",
    schema: { properties: {} },
    async run(ctx) {
      return { services: ctx.catalog.services.map((s) => ({ slug: s.slug, name: s.name, summary: s.directAnswer, ...priceOf(s) })) };
    },
  },
  get_service_info: {
    description: "Details for one catalog service.",
    schema: { properties: { serviceLine: serviceLineProp }, required: ["serviceLine"] },
    async run(ctx, a) {
      const s = serviceByslug(ctx.catalog, a.serviceLine);
      if (!s) return { error: "not_listed", message: "That service is not in our catalog. Staff will confirm." };
      return { slug: s.slug, name: s.name, summary: s.directAnswer, whoFor: s.whoFor, typicalScope: s.typicalScope, priceDrivers: s.priceDrivers, ...priceOf(s) };
    },
  },
  check_coverage: {
    description: "Whether a ZIP code is in our listed service area, and which services are offered there. This is the only source of coverage facts.",
    schema: { properties: { zip: zipProp, serviceLine: serviceLineProp }, required: ["zip"] },
    async run(ctx, a) {
      const area = ctx.catalog.areas.find((x) => x.zip === a.zip);
      if (!area) {
        ctx.coverageChecks.push({ zip: a.zip, listed: false, serviceLine: a.serviceLine ?? null, serviceOffered: false });
        return { listed: false, message: "That ZIP is not listed. Staff will confirm." };
      }
      const base = { listed: true, city: area.city, state: area.state, services: area.serviceLines, travelBand: area.travelBand ?? null };
      if (a.serviceLine) {
        if (!serviceByslug(ctx.catalog, a.serviceLine)) return { ...base, serviceOffered: false, message: "That service is not in our catalog. Staff will confirm." };
        const offered = (area.serviceLines ?? []).includes(a.serviceLine);
        if (!offered) {
          ctx.coverageChecks.push({ zip: a.zip, listed: true, serviceLine: a.serviceLine, serviceOffered: false });
          return { listed: true, serviceOffered: false, message: "That service is not listed for this ZIP. Staff will confirm." };
        }
        ctx.coverageVerified = true;
        ctx.coverageChecks.push({ zip: a.zip, listed: true, serviceLine: a.serviceLine, serviceOffered: true });
        return { ...base, serviceOffered: true };
      }
      ctx.coverageVerified = true;
      ctx.coverageChecks.push({ zip: a.zip, listed: true, serviceLine: null, serviceOffered: null });
      return base;
    },
  },
  check_availability: {
    description: "Open appointment slots, if a scheduling system is connected. Otherwise staff will confirm.",
    schema: { properties: { zip: zipProp, serviceLine: serviceLineProp, window: S(40, { pattern: /^[A-Za-z0-9 :,.\-/]*$/ }) }, required: ["zip", "serviceLine"] },
    async run(ctx, a) {
      if (!serviceByslug(ctx.catalog, a.serviceLine)) return { error: "not_listed", message: "That service is not in our catalog. Staff will confirm." };
      const slots = await fetchSlots(ctx, a);
      if (!slots) return { available: false, message: STAFF_WILL_CONFIRM };
      return { available: true, slots };
    },
  },
  request_estimate: {
    description: "Prepare an estimate request for the customer to review and confirm. Does NOT submit anything.",
    kind: "propose",
    schema: {
      properties: {
        serviceLine: serviceLineProp, zip: zipProp, name: S(120), phone: S(32), email: S(254),
        type: { type: "string", maxLength: 3, enum: ["B2C", "B2B"] }, company: S(160), details: S(500),
      },
      required: ["serviceLine", "zip"],
    },
    async run(ctx, a) {
      const s = serviceByslug(ctx.catalog, a.serviceLine);
      if (!s) return { error: "not_listed", message: "That service is not in our catalog. Staff will confirm." };
      const c = cleanContact(ctx, a);
      if (c.error) return c.error;
      if (a.type === "B2B" && !a.company) return { error: "company_required", message: "Business requests need a company name." };
      let company = null;
      if (a.type === "B2B") {
        company = a.company.replace(/\s+/g, " ").trim();
        if (!COMPANY_OK.test(company) || !guardedText(ctx, company)) return { error: "company_invalid", message: "The company name must be plain letters and numbers." };
      }
      const args = { serviceLine: a.serviceLine, zip: a.zip, ...c.fields, type: a.type ?? "B2C", ...(company ? { company } : {}) };
      const listed = ctx.catalog.areas.some((x) => x.zip === a.zip && (x.serviceLines ?? []).includes(a.serviceLine));
      const summary = `Request an estimate for ${s.name} at ZIP ${a.zip}${listed ? "" : " (not in our listed areas; staff will confirm)"}. We will use: ${contactBits(c.fields)}.${company ? ` Business account: ${company}.` : ""}${noteBit(c.fields)}`;
      return propose(ctx, "request_estimate", args, summary, c.dropped);
    },
  },
  book_appointment: {
    description: "Prepare an appointment request for one of the slots returned by check_availability. Staff still confirm it. Does NOT book anything.",
    kind: "propose",
    schema: {
      properties: { serviceLine: serviceLineProp, zip: zipProp, slot: S(64), name: S(120), phone: S(32), email: S(254), details: S(500) },
      required: ["serviceLine", "zip", "slot"],
    },
    async run(ctx, a) {
      const s = serviceByslug(ctx.catalog, a.serviceLine);
      if (!s) return { error: "not_listed", message: "That service is not in our catalog. Staff will confirm." };
      const slots = await fetchSlots(ctx, a);
      if (!slots) {
        await logAction(ctx.db, { at: ctx.now().toISOString(), conversationId: ctx.conversation.id, actor: "agent", event: "blocked", data: { reason: "booking_disabled", tool: "book_appointment" } });
        return { error: "booking_unavailable", message: `Online booking is not available. ${STAFF_WILL_CONFIRM}` };
      }
      const slot = a.slot;
      if (!slots.includes(slot)) return { error: "slot_not_offered", message: "That slot was not offered. Call check_availability and choose one of its slots." };
      const c = cleanContact(ctx, a);
      if (c.error) return c.error;
      const summary = `Request the ${s.name} appointment at ${slot} for ZIP ${a.zip}. Staff will confirm the time. We will use: ${contactBits(c.fields)}.${noteBit(c.fields)}`;
      return propose(ctx, "book_appointment", { serviceLine: a.serviceLine, zip: a.zip, slot, ...c.fields }, summary, c.dropped);
    },
  },
  request_handoff: {
    description: "Prepare a request for a team member to contact the customer. Does NOT contact anyone.",
    kind: "propose",
    schema: { properties: { name: S(120), phone: S(32), email: S(254), zip: zipProp, serviceLine: serviceLineProp, details: S(500) }, required: [] },
    async run(ctx, a) {
      if (a.serviceLine && !serviceByslug(ctx.catalog, a.serviceLine)) return { error: "not_listed", message: "That service is not in our catalog. Staff will confirm." };
      const c = cleanContact(ctx, a);
      if (c.error) return c.error;
      const summary = `Ask a team member to contact you${a.zip ? ` about ZIP ${a.zip}` : ""}. We will use: ${contactBits(c.fields)}.${noteBit(c.fields)}`;
      return propose(ctx, "request_handoff", { ...(a.zip ? { zip: a.zip } : {}), ...(a.serviceLine ? { serviceLine: a.serviceLine } : {}), ...c.fields }, summary, c.dropped);
    },
  },
};

export const TOOL_NAMES = Object.keys(TOOLS);

// Definitions handed to llm.complete({ tools }).
export function toolDefinitions() {
  return TOOL_NAMES.map((name) => {
    const t = TOOLS[name];
    const properties = {};
    for (const [k, d] of Object.entries(t.schema.properties)) {
      const { pattern, ...rest } = d;
      properties[k] = { ...rest, ...(pattern ? { pattern: pattern.source } : {}) };
    }
    return { name, description: t.description, parameters: { type: "object", additionalProperties: false, properties, required: t.schema.required ?? [] } };
  });
}

// Validates and runs one model-requested call. Never throws for model mistakes; returns a result the model can read.
export async function runToolCall(ctx, call) {
  const rawName = typeof call?.name === "string" ? call.name : "";
  const name = Object.hasOwn(TOOLS, rawName) ? rawName : null;
  const nowIso = ctx.now().toISOString();
  if (!name) {
    await logAction(ctx.db, { at: nowIso, conversationId: ctx.conversation.id, actor: "agent", event: "blocked", data: { reason: "unknown_tool" } });
    return { name: rawName.slice(0, 40), result: { error: "unknown_tool", message: "That tool does not exist." } };
  }
  const v = validate(TOOLS[name].schema, call.args);
  if (!v.ok) {
    await logAction(ctx.db, { at: nowIso, conversationId: ctx.conversation.id, actor: "agent", event: "blocked", data: { reason: "invalid_args", tool: name, problems: v.problems.length } });
    return { name, result: { error: "invalid_arguments", problems: v.problems } };
  }
  const result = await TOOLS[name].run(ctx, v.value);
  if (result?.error === "not_listed") await logAction(ctx.db, { at: nowIso, conversationId: ctx.conversation.id, actor: "agent", event: "blocked", data: { reason: "not_in_catalog", tool: name } });
  return { name, result };
}
