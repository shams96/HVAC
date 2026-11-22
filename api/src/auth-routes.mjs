// Login, logout and user management routes. Registered only when STAFF_AUTH_MODE=users.
import { ROLES } from "./auth.mjs";

const idParams = { type: "object", properties: { id: { type: "string", pattern: "^[0-9]{1,18}$" } }, required: ["id"] };

export async function registerAuthRoutes(app, { staffAuth }) {
  // Public: the only unauthenticated staff-side route. Tight per-IP limit on top of the per-account lockout.
  app.post("/api/auth/login", {
    schema: { body: { type: "object", additionalProperties: false, required: ["email", "password"], properties: { email: { type: "string", maxLength: 254 }, password: { type: "string", maxLength: 256 } } } },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req) => staffAuth.login(req.body.email, req.body.password, req.ip));

  await app.register(async (s) => {
    s.addHook("onRequest", staffAuth.guard);
    const admin = [staffAuth.requireRole("admin")];

    s.post("/logout", async (req) => { await staffAuth.logout(req, req.ip); return { ok: true }; });
    s.get("/me", async (req) => ({ user: { id: req.staff.userId, email: req.staff.email, displayName: req.staff.displayName, role: req.staff.role } }));
    s.post("/password", {
      schema: { body: { type: "object", additionalProperties: false, required: ["currentPassword", "newPassword"], properties: { currentPassword: { type: "string", maxLength: 256 }, newPassword: { type: "string", maxLength: 256 } } } },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    }, async (req) => { await staffAuth.changePassword(req, req.body.currentPassword, req.body.newPassword, req.ip); return { ok: true }; });

    s.get("/users", { onRequest: admin }, async () => ({ users: await staffAuth.listUsers() }));
    s.post("/users", {
      onRequest: admin,
      schema: { body: { type: "object", additionalProperties: false, required: ["email", "displayName", "role", "password"], properties: { email: { type: "string", maxLength: 254 }, displayName: { type: "string", maxLength: 120 }, role: { enum: ROLES }, password: { type: "string", maxLength: 256 } } } },
    }, async (req, reply) => reply.code(201).send({ user: await staffAuth.createUser(req.body, req.ip) }));
    s.post("/users/:id/disable", { onRequest: admin, schema: { params: idParams } }, async (req) => {
      if (Number(req.params.id) === req.staff.userId) { const e = new Error("you cannot disable your own account"); e.statusCode = 400; throw e; }
      return { user: await staffAuth.disableUser(req.params.id, req.ip) };
    });
  }, { prefix: "/api/staff" });
}
