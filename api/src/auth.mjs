// Staff authentication. Two modes:
//   shared: one bearer token, acting person asserted in the request body (legacy, kept so nothing breaks).
//   users:  per-user accounts with scrypt passwords and server-side sessions; the server decides who is acting.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const digest = (s) => createHash("sha256").update(String(s)).digest();
const sha256hex = (s) => createHash("sha256").update(String(s)).digest("hex");

export const ROLES = ["staff", "approver", "admin"];
const DEFAULT_N = 2 ** 15;
const MAXMEM = 256 * 1024 * 1024;
const MIN = 60_000;

const httpError = (statusCode, message, code) => Object.assign(new Error(message), { statusCode, code });

// ---- passwords ----
export async function hashPassword(password, { N = DEFAULT_N } = {}) {
  const salt = randomBytes(16);
  const key = await scryptAsync(String(password), salt, 64, { N, r: 8, p: 1, maxmem: MAXMEM });
  return `scrypt$${N}$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (!Number.isInteger(N) || N < 1024 || N > 2 ** 20 || (N & (N - 1)) !== 0 || r !== 8 || p !== 1) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (!salt.length || !expected.length) return false;
  const key = await scryptAsync(String(password), salt, expected.length, { N, r, p, maxmem: MAXMEM });
  return timingSafeEqual(key, expected);
}

export function passwordProblem(password, email = "") {
  if (typeof password !== "string") return "password must be a string";
  if (password.length < 12) return "password must be at least 12 characters";
  if (password.length > 128) return "password must be at most 128 characters";
  if (password.toLowerCase() === String(email).toLowerCase()) return "password must not equal the email address";
  if (new Set(password).size < 4) return "password is too repetitive";
  return null;
}

export const normalizeEmail = (e) => String(e ?? "").trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- legacy shared-token guard (still exported for callers that only need that) ----
export function requireStaff(staffToken) {
  return async (req, reply) => {
    if (!staffToken) return reply.code(503).send({ error: "staff_auth_not_configured", message: "Staff API is disabled" });
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m || !timingSafeEqual(digest(m[1]), digest(staffToken))) return reply.code(401).send({ error: "unauthorized", message: "Missing or invalid token" });
  };
}

export function createStaffAuth({
  db, staffToken = null, mode = "shared", now = () => new Date(), scryptN = DEFAULT_N,
  sessionTtlMs = 12 * 60 * MIN, idleMs = 60 * MIN, maxFailures = 5, lockMs = 15 * MIN,
} = {}) {
  if (!["shared", "users"].includes(mode)) throw new Error(`unknown staff auth mode: ${mode}`);
  const shared = mode === "shared";
  const sharedGuard = requireStaff(staffToken);
  let dummy = null;
  const dummyHash = () => (dummy ??= hashPassword("not-a-real-password-for-timing", { N: scryptN }));

  const event = (type, { userId = null, email = null, ip = null } = {}) =>
    db.query("INSERT INTO staff_auth_events (at, user_id, email_attempted, event, ip) VALUES ($1, $2, $3, $4, $5)",
      [now(), userId, email ? String(email).slice(0, 254) : null, type, ip]);

  const publicUser = (u) => ({ id: Number(u.id), email: u.email, displayName: u.display_name, role: u.role, disabled: !!u.disabled_at });

  async function guard(req, reply) {
    if (shared) { await sharedGuard(req, reply); if (!reply.sent) req.staff = { kind: "shared" }; return; }
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const deny = () => reply.code(401).send({ error: "unauthorized", message: "Missing, expired or invalid session" });
    if (!m) return deny();
    const t = now();
    const row = (await db.query(
      `SELECT s.id AS sid, s.expires_at, s.last_seen_at, u.id AS uid, u.email, u.display_name, u.role, u.disabled_at
         FROM staff_sessions s JOIN staff_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL`, [sha256hex(m[1])])).rows[0];
    if (!row || row.disabled_at) return deny();
    if (new Date(row.expires_at) <= t || t - new Date(row.last_seen_at) > idleMs) return deny();
    if (t - new Date(row.last_seen_at) > MIN) await db.query("UPDATE staff_sessions SET last_seen_at = $2 WHERE id = $1", [row.sid, t]);
    req.staff = { kind: "user", userId: Number(row.uid), email: row.email, displayName: row.display_name, role: row.role, sessionId: Number(row.sid) };
  }

  // Who is acting. In users mode the session decides; a different claimed actor is refused, never trusted.
  function actor(req, claimed) {
    if (shared) {
      if (!claimed) throw httpError(400, "actor is required", "actor_required");
      return claimed;
    }
    const me = { type: "user", id: req.staff.email };
    if (claimed && (claimed.type !== me.type || claimed.id !== me.id)) throw httpError(403, "actor does not match the signed-in user", "actor_mismatch");
    return me;
  }

  // Role gate as an onRequest hook (runs after the scope's auth guard). No-op in shared mode, which has no roles.
  const requireRole = (...allowed) => async (req, reply) => {
    if (shared || reply.sent) return;
    if (!allowed.includes(req.staff?.role)) return reply.code(403).send({ error: "forbidden", message: `Requires role: ${allowed.join(" or ")}` });
  };

  async function login(emailRaw, password, ip) {
    const email = normalizeEmail(emailRaw);
    const user = (await db.query("SELECT * FROM staff_users WHERE email = $1", [email])).rows[0];
    const t = now();
    const locked = user?.locked_until && new Date(user.locked_until) > t;
    // Same work and same answer for unknown, disabled, locked and wrong-password cases.
    const ok = await verifyPassword(password, user && !locked ? user.password_hash : await dummyHash());
    const good = !!(ok && user && !user.disabled_at && !locked);
    if (!good) {
      if (user && !locked && !user.disabled_at) {
        const failed = user.failed_logins + 1;
        const lock = failed >= maxFailures;
        await db.query("UPDATE staff_users SET failed_logins = $2, locked_until = $3 WHERE id = $1", [user.id, lock ? 0 : failed, lock ? new Date(t.getTime() + lockMs) : null]);
        await event(lock ? "login_locked" : "login_failed", { userId: user.id, email, ip });
      } else {
        await event(locked ? "login_locked" : "login_failed", { userId: user?.id ?? null, email, ip });
      }
      throw httpError(401, "Invalid email or password", "invalid_credentials");
    }
    await db.query("UPDATE staff_users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [user.id]);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(t.getTime() + sessionTtlMs);
    await db.query("INSERT INTO staff_sessions (user_id, token_hash, created_at, last_seen_at, expires_at) VALUES ($1, $2, $3, $3, $4)", [user.id, sha256hex(token), t, expiresAt]);
    await event("login_ok", { userId: user.id, email, ip });
    return { token, expiresAt: expiresAt.toISOString(), user: publicUser(user) };
  }

  const revokeSessions = (userId, exceptSessionId = null) =>
    db.query("UPDATE staff_sessions SET revoked_at = $3 WHERE user_id = $1 AND revoked_at IS NULL AND ($2::bigint IS NULL OR id <> $2::bigint)", [userId, exceptSessionId, now()]);

  async function logout(req, ip) {
    await db.query("UPDATE staff_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [req.staff.sessionId, now()]);
    await event("logout", { userId: req.staff.userId, email: req.staff.email, ip });
  }

  async function createUser({ email: emailRaw, displayName, role, password }, ip = null) {
    const email = normalizeEmail(emailRaw);
    if (!EMAIL_RE.test(email) || email.length > 64) throw httpError(400, "a valid email address of at most 64 characters is required", "invalid_email");
    if (!ROLES.includes(role)) throw httpError(400, `role must be one of ${ROLES.join(", ")}`, "invalid_role");
    if (!displayName || String(displayName).length > 120) throw httpError(400, "displayName is required (at most 120 characters)", "invalid_name");
    const problem = passwordProblem(password, email);
    if (problem) throw httpError(400, problem, "weak_password");
    try {
      const r = await db.query(
        "INSERT INTO staff_users (email, display_name, role, password_hash, password_changed_at, created_at) VALUES ($1, $2, $3, $4, $5, $5) RETURNING *",
        [email, String(displayName), role, await hashPassword(password, { N: scryptN }), now()]);
      await event("user_created", { userId: r.rows[0].id, email, ip });
      return publicUser(r.rows[0]);
    } catch (e) {
      if (e.code === "23505") throw httpError(409, "a user with that email already exists", "user_exists");
      throw e;
    }
  }

  async function disableUser(id, ip = null) {
    const r = await db.query("UPDATE staff_users SET disabled_at = COALESCE(disabled_at, $2) WHERE id = $1 RETURNING *", [id, now()]);
    if (!r.rows[0]) throw httpError(404, "no such user", "not_found");
    await revokeSessions(id);
    await event("user_disabled", { userId: r.rows[0].id, email: r.rows[0].email, ip });
    return publicUser(r.rows[0]);
  }

  async function changePassword(req, current, next, ip) {
    const u = (await db.query("SELECT * FROM staff_users WHERE id = $1", [req.staff.userId])).rows[0];
    if (!(await verifyPassword(current, u.password_hash))) throw httpError(401, "Current password is incorrect", "invalid_credentials");
    const problem = passwordProblem(next, u.email);
    if (problem) throw httpError(400, problem, "weak_password");
    await db.query("UPDATE staff_users SET password_hash = $2, password_changed_at = $3 WHERE id = $1", [u.id, await hashPassword(next, { N: scryptN }), now()]);
    await revokeSessions(u.id, req.staff.sessionId); // other devices are signed out; this one stays
    await event("password_changed", { userId: u.id, email: u.email, ip });
  }

  // Admin or CLI reset: signs the user out everywhere and clears any lockout.
  async function setPassword(emailRaw, next, ip = null) {
    const email = normalizeEmail(emailRaw);
    const problem = passwordProblem(next, email);
    if (problem) throw httpError(400, problem, "weak_password");
    const r = await db.query("UPDATE staff_users SET password_hash = $2, password_changed_at = $3, failed_logins = 0, locked_until = NULL WHERE email = $1 RETURNING *",
      [email, await hashPassword(next, { N: scryptN }), now()]);
    if (!r.rows[0]) throw httpError(404, "no such user", "not_found");
    await revokeSessions(r.rows[0].id);
    await event("password_reset", { userId: r.rows[0].id, email, ip });
    return publicUser(r.rows[0]);
  }

  const listUsers = async () => (await db.query("SELECT * FROM staff_users ORDER BY id")).rows.map(publicUser);
  const countUsers = async () => Number((await db.query("SELECT count(*) AS n FROM staff_users WHERE disabled_at IS NULL")).rows[0].n);

  return { mode, guard, actor, requireRole, login, logout, createUser, disableUser, changePassword, setPassword, listUsers, countUsers };
}
