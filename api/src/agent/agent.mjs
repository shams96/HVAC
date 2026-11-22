// Chat agent harness. The model is untrusted: every invariant (A1-A12) is enforced here, in code around it.
import { createHash, randomBytes } from "node:crypto";
import { createLead } from "../repo/leads.mjs";
import { CHANNELS } from "../domain/consent.mjs";
import { cleanText } from "./text.mjs";
import { detectEmergency, emergencyReply, emergencyClosedReply } from "./emergency.mjs";
import { checkScope, SCOPE_REFUSAL } from "./scope.mjs";
import { guardReply, SAFE_FALLBACK } from "./guard.mjs";
import { toolDefinitions, runToolCall } from "./tools.mjs";
import { systemPrompt, wrapData, newNonce } from "./prompt.mjs";
import { logAction } from "./log.mjs";

export class AgentError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const MAX_MESSAGE_CHARS = 2000;
const MAX_TOOL_ROUNDS = 4;
const MAX_CALLS_PER_ROUND = 4;
const HISTORY_LIMIT = 20;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const ACTION_ID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hashToken = (t) => createHash("sha256").update(t).digest("hex");
const REMOVED = "[removed]";

export const GREETING =
  "Hi, I'm an automated assistant for this company, not a person. I can answer questions about our services and service areas and help you prepare an estimate request. " +
  "I can't give prices that aren't published, promise arrival times, or handle emergencies. If you smell gas or smoke, leave the building and call 911.";

const SUBMITTED = {
  request_estimate: "Thank you. Your estimate request was submitted. A team member will contact you.",
  book_appointment: "Thank you. Your appointment request was submitted. It is not booked until a team member confirms the time with you.",
  request_handoff: "Thank you. Your request was submitted. A team member will contact you.",
};
const PENDING_NOTICE = "Nothing has been sent yet. Review the request below and press Confirm to send it, or Cancel.";

export function createAgent({ db, now, catalog, llm, availability = null, sla, conversationTtlMin = 60, actionTtlMin = 15, maxTurns = 30, llmTimeoutMs = 20_000 }) {
  if (!db) throw new Error("createAgent: db is required");
  const clock = () => (typeof now === "function" ? now() : now instanceof Date ? now : new Date());
  const cat = catalog ?? { business: {}, services: [], areas: [], emergencyGuidance: null, bannedClaims: [] };
  const system = systemPrompt(cat);
  const tools = toolDefinitions();

  async function loadConversation(token) {
    if (typeof token !== "string" || !TOKEN_FORMAT.test(token)) throw new AgentError("invalid_token", "Unknown conversation", 401);
    const row = (await db.query("SELECT * FROM conversations WHERE token_hash = $1", [hashToken(token)])).rows[0];
    if (!row) throw new AgentError("invalid_token", "Unknown conversation", 401);
    return row;
  }
  const isExpired = (conv) => new Date(conv.expires_at).getTime() <= clock().getTime();

  // Pending actions past their TTL become 'expired' (logged once, details scrubbed).
  async function expireStale(conversationId = null) {
    const nowIso = clock().toISOString();
    const r = await db.query(
      `UPDATE pending_actions SET status = 'expired', resolved_at = $1::timestamptz, args = '{}'::jsonb, summary = $2
       WHERE status = 'pending' AND expires_at <= $1::timestamptz AND ($3::bigint IS NULL OR conversation_id = $3::bigint)
       RETURNING id, conversation_id`,
      [nowIso, REMOVED, conversationId]
    );
    for (const row of r.rows) await logAction(db, { at: nowIso, conversationId: row.conversation_id, actionId: row.id, actor: "system", event: "expired", data: {} });
    return r.rows.length;
  }

  async function listPending(conversationId) {
    const r = await db.query(
      "SELECT id, kind, summary, expires_at FROM pending_actions WHERE conversation_id = $1 AND status = 'pending' AND expires_at > $2::timestamptz ORDER BY created_at, id",
      [conversationId, clock().toISOString()]
    );
    return r.rows.map((x) => ({ id: x.id, kind: x.kind, summary: x.summary, expiresAt: new Date(x.expires_at).toISOString() }));
  }

  async function storeMessage(conversationId, role, content) {
    await db.query("INSERT INTO chat_messages (conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4::timestamptz)", [conversationId, role, content, clock().toISOString()]);
  }

  async function start() {
    const token = randomBytes(32).toString("base64url");
    const t = clock();
    const expires = new Date(t.getTime() + conversationTtlMin * 60_000);
    await db.query("INSERT INTO conversations (token_hash, created_at, expires_at) VALUES ($1, $2::timestamptz, $3::timestamptz)", [hashToken(token), t.toISOString(), expires.toISOString()]);
    return { token, expiresAt: expires.toISOString(), greeting: GREETING };
  }

  async function callModel(messages) {
    let timer;
    try {
      const res = await Promise.race([
        llm.complete({ system, messages, tools }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("llm timeout")), llmTimeoutMs); timer.unref?.(); }),
      ]);
      return res && typeof res === "object" ? res : {};
    } finally {
      clearTimeout(timer);
    }
  }

  async function message(token, rawText) {
    const conv = await loadConversation(token);
    const expired = isExpired(conv);
    const text = cleanText(rawText);
    const valid = typeof rawText === "string" && text.length > 0;

    // A5 runs first, on whatever the customer typed, so no limit below can swallow safety guidance. A split report
    // ("there is gas near the furnace" ... "I can smell it now") is judged together with the previous customer message.
    let em = valid ? detectEmergency(text) : { emergency: false, reasons: [] };
    if (valid && !em.emergency && !expired) {
      const prev = (await db.query("SELECT content FROM chat_messages WHERE conversation_id = $1 AND role = 'user' AND content IS NOT NULL ORDER BY id DESC LIMIT 1", [conv.id])).rows[0]?.content;
      // an earlier message that was itself an emergency was already answered; only an unflagged one can combine with this one
      if (prev && !detectEmergency(prev).emergency) em = detectEmergency(`${prev} ${text}`);
    }

    if (expired && !em.emergency) throw new AgentError("conversation_expired", "This conversation has expired. Please start a new one.", 410);
    if (!valid) throw new AgentError("invalid_message", "Message is empty", 400);
    if (!em.emergency && text.length > MAX_MESSAGE_CHARS) throw new AgentError("message_too_long", `Messages are limited to ${MAX_MESSAGE_CHARS} characters`, 400);

    const nowIso = clock().toISOString();
    // Atomic turn accounting: concurrent requests cannot slip past the limit.
    const turn = await db.query(
      "UPDATE conversations SET turns = turns + 1 WHERE id = $1 AND turns < $2 AND expires_at > $3::timestamptz RETURNING turns",
      [conv.id, maxTurns, nowIso]
    );
    if (!turn.rows.length) {
      if (em.emergency) {
        // Expired or out of turns: nothing is stored and no model runs, but the safety guidance still goes out.
        await db.query("UPDATE conversations SET emergency = true WHERE id = $1", [conv.id]);
        await logAction(db, { at: nowIso, conversationId: conv.id, actor: "system", event: "blocked", data: { reason: "emergency_precheck", signals: em.reasons, limit: expired ? "expired" : "turn_limit" } });
        return { reply: emergencyClosedReply(cat), pendingActions: [], emergency: true, handoffOffered: false };
      }
      await logAction(db, { at: nowIso, conversationId: conv.id, actor: "system", event: "blocked", data: { reason: "turn_limit" } });
      throw new AgentError("turn_limit", "This conversation has reached its message limit. Please start a new one or ask for a team member to contact you.", 429);
    }

    await expireStale(conv.id);
    await storeMessage(conv.id, "user", text.slice(0, MAX_MESSAGE_CHARS));

    const reply = async (replyText, extra = {}) => {
      await storeMessage(conv.id, "assistant", replyText);
      return { reply: replyText, pendingActions: await listPending(conv.id), emergency: false, handoffOffered: false, ...extra };
    };

    // A5: emergency first, deterministic, no model call.
    if (em.emergency) {
      await db.query("UPDATE conversations SET emergency = true WHERE id = $1", [conv.id]);
      await logAction(db, { at: nowIso, conversationId: conv.id, actor: "system", event: "blocked", data: { reason: "emergency_precheck", signals: em.reasons } });
      return reply(emergencyReply(cat), { emergency: true, handoffOffered: true });
    }

    // A9: deterministic scope refusal, no model call.
    const scope = checkScope(text);
    if (scope.outOfScope) {
      await logAction(db, { at: nowIso, conversationId: conv.id, actor: "system", event: "blocked", data: { reason: "out_of_scope", category: scope.category } });
      return reply(SCOPE_REFUSAL, { handoffOffered: true });
    }

    // ---- model turn ----
    const hist = (await db.query("SELECT role, content FROM chat_messages WHERE conversation_id = $1 AND content IS NOT NULL ORDER BY id DESC LIMIT $2", [conv.id, HISTORY_LIMIT])).rows.reverse();
    const userTexts = hist.filter((h) => h.role === "user").map((h) => h.content);
    const nonce = newNonce();
    const messages = hist.map((h) => (h.role === "user" ? { role: "user", content: wrapData("customer", h.content, nonce) } : { role: "assistant", content: h.content }));
    const ctx = { db, catalog: cat, availability, conversation: { id: conv.id }, now: clock, actionTtlMin, proposals: [], coverageVerified: false, coverageChecks: [] };

    let finalText = null;
    let failure = null;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await callModel(messages);
        const calls = Array.isArray(res.toolCalls) ? res.toolCalls.filter((c) => c && typeof c === "object").slice(0, MAX_CALLS_PER_ROUND) : [];
        if (!calls.length) { finalText = typeof res.text === "string" ? res.text : ""; break; }
        const withIds = calls.map((c, i) => ({ id: typeof c.id === "string" ? c.id.slice(0, 64) : `call_${round}_${i}`, name: c.name, args: c.args }));
        messages.push({ role: "assistant", content: "", toolCalls: withIds });
        for (const call of withIds) {
          const out = await runToolCall(ctx, call);
          messages.push({ role: "tool", toolCallId: call.id, name: out.name, content: wrapData("tool", JSON.stringify(out.result), nonce) });
        }
      }
      if (finalText === null) failure = "tool_loop_limit";
    } catch {
      failure = "llm_error"; // message text and error detail are deliberately not logged
    }

    let out;
    if (failure) {
      await logAction(db, { at: nowIso, conversationId: conv.id, actor: "system", event: "blocked", data: { reason: failure } });
      out = SAFE_FALLBACK;
    } else {
      const g = guardReply(finalText, { catalog: cat, userTexts, coverageVerified: ctx.coverageVerified, coverageChecks: ctx.coverageChecks, system });
      if (!g.ok) await logAction(db, { at: nowIso, conversationId: conv.id, actor: "agent", event: "blocked", data: { reason: "output_guard", rules: g.reasons } });
      out = g.text;
    }
    if (ctx.proposals.length) out = `${out}\n\n${PENDING_NOTICE}`;
    return reply(out, { handoffOffered: out === SAFE_FALLBACK });
  }

  // ---- out-of-band resolution: only these two functions change a pending action's state ----

  async function refuse(conv, actionId, code, reason, status) {
    await logAction(db, { at: clock().toISOString(), conversationId: conv.id, actionId: ACTION_ID_FORMAT.test(String(actionId)) ? actionId : null, actor: "customer", event: "blocked", data: { reason } });
    throw new AgentError(code, "This request can no longer be confirmed.", status);
  }

  function leadInput(row, conv, consents) {
    const a = row.args;
    const details = { via: "chat-agent", pendingActionId: row.id, ...(a.details ? { note: a.details } : {}) };
    if (row.kind === "book_appointment") Object.assign(details, { appointmentRequest: true, requestedSlot: a.slot });
    if (row.kind === "request_handoff") details.handoff = true;
    const type = a.type === "B2B" ? "B2B" : "B2C";
    return {
      type, channel: "chat", name: a.name, phone: a.phone, email: a.email, zip: a.zip,
      serviceLine: a.serviceLine ?? "general",
      emergency: conv.emergency === true, // set only by the deterministic pre-check
      details, source: "chat-agent", consents,
      ...(type === "B2B" ? { b2b: { company: a.company, kind: "commercial" } } : {}),
    };
  }

  // consents come ONLY from the confirm request body (A3).
  async function confirm(token, actionId, consents = []) {
    const conv = await loadConversation(token);
    if (isExpired(conv)) {
      await logAction(db, { at: clock().toISOString(), conversationId: conv.id, actor: "system", event: "blocked", data: { reason: "conversation_expired" } });
      throw new AgentError("conversation_expired", "This conversation has expired.", 410);
    }
    if (!Array.isArray(consents) || consents.length > CHANNELS.length || consents.some((c) => !c || typeof c !== "object" || !CHANNELS.includes(c.channel) || (c.wordingVersion != null && typeof c.wordingVersion !== "string"))) {
      throw new AgentError("invalid_consents", "Invalid consent selection", 400);
    }
    const cleanConsents = consents.map((c) => ({ channel: c.channel, wordingVersion: c.wordingVersion ? c.wordingVersion.slice(0, 32) : undefined }));
    if (typeof actionId !== "string" || !ACTION_ID_FORMAT.test(actionId)) return refuse(conv, actionId, "confirmation_refused", "unknown_action", 409);

    const nowIso = clock().toISOString();
    // Single atomic claim: wrong conversation, not pending, expired and double confirm all return zero rows.
    const claimed = (
      await db.query(
        `UPDATE pending_actions SET status = 'confirmed', resolved_at = $3::timestamptz
         WHERE id = $1 AND conversation_id = $2 AND status = 'pending' AND expires_at > $3::timestamptz RETURNING *`,
        [actionId, conv.id, nowIso]
      )
    ).rows[0];
    if (!claimed) {
      const row = (await db.query("SELECT status, expires_at FROM pending_actions WHERE id = $1 AND conversation_id = $2", [actionId, conv.id])).rows[0];
      if (!row) return refuse(conv, actionId, "confirmation_refused", "unknown_action", 409);
      if (row.status === "pending") { await expireStale(conv.id); return refuse(conv, actionId, "confirmation_refused", "expired", 409); }
      return refuse(conv, actionId, "confirmation_refused", row.status === "expired" ? "expired" : "not_pending", 409);
    }

    let lead;
    try {
      lead = await createLead(db, leadInput(claimed, conv, cleanConsents), { now: clock(), sla });
    } catch (e) {
      // Nothing was created: hand the action back so the customer can fix the input and retry.
      await db.query("UPDATE pending_actions SET status = 'pending', resolved_at = NULL WHERE id = $1 AND status = 'confirmed' AND result IS NULL", [actionId]);
      throw e;
    }
    await db.transaction(async (tx) => {
      await tx.query("UPDATE pending_actions SET result = $2::jsonb, args = '{}'::jsonb, summary = $3 WHERE id = $1", [actionId, JSON.stringify({ leadId: lead.id, deduped: lead.deduped }), REMOVED]);
      // A11: createLead stamps its own event as the customer intake channel; this adds the agent attribution.
      await tx.query(
        `INSERT INTO lead_events (lead_id, at, actor_type, actor_id, event_type, data) VALUES ($1, $2::timestamptz, 'agent', 'chat-agent', 'agent_request_confirmed', $3::jsonb)`,
        [lead.id, nowIso, JSON.stringify({ action_id: actionId, kind: claimed.kind, conversation_id: Number(conv.id) })]
      );
      await tx.query(
        `INSERT INTO agent_actions_log (at, conversation_id, action_id, actor_type, event, data) VALUES ($1::timestamptz, $2, $3, 'customer', 'confirmed', $4::jsonb)`,
        [nowIso, conv.id, actionId, JSON.stringify({ kind: claimed.kind, lead_id: lead.id, consent_channels: cleanConsents.map((c) => c.channel) })]
      );
    });
    return { ok: true, kind: claimed.kind, leadId: lead.id, deduped: lead.deduped, message: SUBMITTED[claimed.kind] };
  }

  async function reject(token, actionId) {
    const conv = await loadConversation(token);
    if (typeof actionId !== "string" || !ACTION_ID_FORMAT.test(actionId)) return refuse(conv, actionId, "rejection_refused", "unknown_action", 409);
    const nowIso = clock().toISOString();
    const r = await db.query(
      `UPDATE pending_actions SET status = 'rejected', resolved_at = $3::timestamptz, args = '{}'::jsonb, summary = $4
       WHERE id = $1 AND conversation_id = $2 AND status = 'pending' AND expires_at > $3::timestamptz RETURNING id`,
      [actionId, conv.id, nowIso, REMOVED]
    );
    if (!r.rows.length) {
      await expireStale(conv.id);
      return refuse(conv, actionId, "rejection_refused", "not_pending", 409);
    }
    await logAction(db, { at: nowIso, conversationId: conv.id, actionId, actor: "customer", event: "rejected", data: {} });
    return { ok: true };
  }

  return { start, message, confirm, reject, expireStale, listPending };
}
