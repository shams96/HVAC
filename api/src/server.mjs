import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import { createStaffAuth } from "./auth.mjs";
import { registerAuthRoutes } from "./auth-routes.mjs";
import { registerAgentRoutes } from "./agent/routes.mjs";
import { registerSocialRoutes } from "./social/routes.mjs";
import { createLead, transitionLead, getLead, optOut, addSite, addAgreement, PipelineError } from "./repo/leads.mjs";

const CONSENT_CHANNELS = ["call", "sms", "email", "marketing"];
const siteSchema = {
  type: "object", additionalProperties: false, required: ["label"],
  properties: { label: { type: "string", minLength: 1, maxLength: 120 }, streetAddress: { type: "string", maxLength: 200 }, zip: { type: "string", pattern: "^[0-9]{5}$" } },
};
const leadBody = (channels) => ({
  type: "object", additionalProperties: false, required: ["type", "channel", "serviceLine"],
  properties: {
    type: { enum: ["B2C", "B2B"] },
    channel: { enum: channels },
    name: { type: "string", maxLength: 120 },
    phone: { type: "string", maxLength: 32 },
    email: { type: "string", maxLength: 254 },
    zip: { type: "string", pattern: "^[0-9]{5}$" },
    serviceLine: { type: "string", pattern: "^[a-z0-9-]{1,64}$" },
    emergency: { type: "boolean" },
    details: { type: "object" },
    source: { type: "string", maxLength: 64 },
    consents: {
      type: "array", maxItems: 4,
      items: { type: "object", additionalProperties: false, required: ["channel"], properties: { channel: { enum: CONSENT_CHANNELS }, wordingVersion: { type: "string", maxLength: 32 } } },
    },
    b2b: {
      type: "object", additionalProperties: false, required: ["company"],
      properties: {
        company: { type: "string", minLength: 1, maxLength: 160 },
        kind: { enum: ["commercial", "property_management"] },
        role: { type: "string", maxLength: 80 },
        sites: { type: "array", maxItems: 50, items: siteSchema },
      },
    },
    website: { type: "string", maxLength: 200 }, // honeypot: real people never fill this
  },
});
const idParams = { type: "object", properties: { id: { type: "string", pattern: "^[0-9]{1,18}$" } }, required: ["id"] };
const actorSchema = {
  type: "object", additionalProperties: false, required: ["type", "id"],
  properties: { type: { enum: ["user", "system", "agent", "webhook"] }, id: { type: "string", minLength: 1, maxLength: 64 } },
};

export async function buildServer({ db, staffToken, now = () => new Date(), sla, logger = false, intakeLimit = 10, trustProxy = false, agentDeps = null, socialDeps = null, corsOrigins = [], staffMode = "shared", scryptN }) {
  const staffAuth = createStaffAuth({ db, staffToken, mode: staffMode, now, scryptN });
  const app = Fastify({ logger: logger ? { level: "info", redact: ["req.headers.authorization"] } : false, bodyLimit: 64 * 1024, trustProxy });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });
  // Browser access from the website only (exact origins). The Authorization header is not allowed cross-origin, so
  // browsers on those origins cannot call the staff API even with a token; chat uses a token in the body, not cookies.
  if (corsOrigins.length) await app.register(cors, { origin: corsOrigins, methods: ["POST", "OPTIONS"], allowedHeaders: ["content-type"], maxAge: 600 });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof PipelineError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err.validation) return reply.code(400).send({ error: "invalid_request", message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: "request_error", message: err.message });
    req.log.error({ err: { message: err.message } }, "unhandled error");
    return reply.code(500).send({ error: "internal_error", message: "Something went wrong" });
  });

  app.get("/healthz", { config: { rateLimit: false } }, async () => ({ ok: true }));

  // ---- public ----
  app.post("/api/leads", { schema: { body: leadBody(["form", "booking", "chat"]) }, config: { rateLimit: { max: intakeLimit, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (req.body.website) return reply.code(201).send({ ok: true }); // bot: pretend success, store nothing
    const r = await createLead(db, req.body, { now: now(), sla });
    return reply.code(201).send({ ok: true, id: r.id, deduped: r.deduped });
  });

  app.post("/api/opt-out", {
    schema: { body: { type: "object", additionalProperties: false, required: ["channel"], properties: { phone: { type: "string", maxLength: 32 }, email: { type: "string", maxLength: 254 }, channel: { enum: [...CONSENT_CHANNELS, "all"] } } } },
    config: { rateLimit: { max: intakeLimit, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    await optOut(db, req.body, now());
    return reply.code(200).send({ ok: true }); // same answer whether or not we knew them
  });

  // ---- staff (shared token in STAFF_AUTH_MODE=shared, per-user sessions in =users) ----
  app.decorate("staffAuth", staffAuth);
  if (staffAuth.mode === "users") await registerAuthRoutes(app, { staffAuth });
  await app.register(async (staff) => {
    staff.addHook("onRequest", staffAuth.guard);

    staff.post("/leads", { schema: { body: leadBody(["call", "form", "booking", "chat"]) } }, async (req, reply) => {
      const r = await createLead(db, req.body, { now: now(), sla });
      return reply.code(201).send({ ok: true, id: r.id, deduped: r.deduped });
    });

    staff.get("/leads/:id", { schema: { params: idParams } }, async (req) => {
      const { lead, contact, events } = await getLead(db, req.params.id);
      return { lead, contact, events };
    });

    staff.post("/leads/:id/transition", {
      schema: { params: idParams, body: { type: "object", additionalProperties: false, required: ["to"], properties: { to: { type: "string", maxLength: 20 }, reason: { type: "string", maxLength: 500 }, actor: actorSchema } } },
    }, async (req) => transitionLead(db, req.params.id, req.body.to, staffAuth.actor(req, req.body.actor), { reason: req.body.reason, now: now() }));

    staff.post("/accounts/:id/sites", { schema: { params: idParams, body: siteSchema } }, async (req, reply) =>
      reply.code(201).send({ id: await addSite(db, req.params.id, req.body, now()) }));

    staff.post("/accounts/:id/agreements", {
      schema: {
        params: idParams,
        body: {
          type: "object", additionalProperties: false, required: ["kind", "startsOn"],
          properties: { kind: { type: "string", minLength: 1, maxLength: 80 }, startsOn: { type: "string", format: "date" }, endsOn: { type: "string", format: "date" }, siteId: { type: "integer" } },
        },
      },
    }, async (req, reply) => reply.code(201).send({ id: await addAgreement(db, req.params.id, req.body, now()) }));
  }, { prefix: "/api/staff" });

  // Optional modules (Phase 4). Each owns its own routes, tables and tests.
  if (agentDeps) {
    const agent = await registerAgentRoutes(app, { db, now, sla, ...agentDeps });
    if (agent) app.decorate("agent", agent); // used by background jobs (expire stale proposals)
  }
  if (socialDeps) await registerSocialRoutes(app, { db, now, staffAuth, ...socialDeps });

  return app;
}
