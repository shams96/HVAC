import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s) => createHash("sha256").update(String(s)).digest();

// Fastify onRequest hook factory for staff-only routes (shared bearer token for now; per-user auth is an open item).
export function requireStaff(staffToken) {
  return async (req, reply) => {
    if (!staffToken) return reply.code(503).send({ error: "staff_auth_not_configured", message: "Staff API is disabled" });
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m || !timingSafeEqual(digest(m[1]), digest(staffToken))) return reply.code(401).send({ error: "unauthorized", message: "Missing or invalid token" });
  };
}
