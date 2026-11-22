// PUBLIC chat routes. The conversation token (body) is the only credential; confirm/reject are separate HTTP calls
// the model cannot make. Rate limits are per client IP and tighter than the server default.
import { createAgent, AgentError, MAX_MESSAGE_CHARS } from "./agent.mjs";

export { createAgent, AgentError } from "./agent.mjs";
export { purgeChats } from "./privacy.mjs";

const token = { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" };
const consentItem = {
  type: "object", additionalProperties: false, required: ["channel"],
  properties: { channel: { enum: ["call", "sms", "email", "marketing"] }, wordingVersion: { type: "string", maxLength: 32 } },
};
const DEFAULT_LIMITS = { start: 10, message: 30, confirm: 20, reject: 20 };

export async function registerAgentRoutes(app, { db, now, catalog, llm, availability, sla, conversationTtlMin, actionTtlMin, maxTurns, limits = {}, llmTimeoutMs }) {
  const agent = createAgent({ db, now, catalog, llm, availability, sla, conversationTtlMin, actionTtlMin, maxTurns, llmTimeoutMs });
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const rl = (max) => ({ rateLimit: { max, timeWindow: "1 minute" } });

  // Wraps a handler: AgentError -> JSON error; anything else falls through to the server's generic 500 handler.
  const handle = (fn) => async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof AgentError) return reply.code(e.status).send({ error: e.code, message: e.message });
      throw e;
    }
  };

  app.post("/api/chat/start", { config: rl(lim.start), bodyLimit: 1024 }, handle(async (_req, reply) => reply.code(201).send(await agent.start())));

  app.post("/api/chat/message", {
    bodyLimit: 16 * 1024,
    config: rl(lim.message),
    // The route accepts more than MAX_MESSAGE_CHARS on purpose: the agent refuses an over-long message, except that an
    // emergency report must never be rejected for its length and still gets safety guidance (A5).
    schema: { body: { type: "object", additionalProperties: false, required: ["token", "text"], properties: { token, text: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS * 2 } } } },
  }, handle(async (req) => agent.message(req.body.token, req.body.text)));

  app.post("/api/chat/confirm", {
    bodyLimit: 4 * 1024,
    config: rl(lim.confirm),
    schema: { body: { type: "object", additionalProperties: false, required: ["token", "actionId"], properties: { token, actionId: { type: "string", maxLength: 64 }, consents: { type: "array", maxItems: 4, items: consentItem } } } },
  }, handle(async (req) => {
    const r = await agent.confirm(req.body.token, req.body.actionId, req.body.consents ?? []);
    return { ok: true, message: r.message };
  }));

  app.post("/api/chat/reject", {
    bodyLimit: 2 * 1024,
    config: rl(lim.reject),
    schema: { body: { type: "object", additionalProperties: false, required: ["token", "actionId"], properties: { token, actionId: { type: "string", maxLength: 64 } } } },
  }, handle(async (req) => agent.reject(req.body.token, req.body.actionId)));

  return agent;
}
