import { test } from "node:test";
import assert from "node:assert/strict";
import { newDb, T0 } from "./helpers.mjs";
import { fixtureCatalog } from "./catalog-fixture.mjs";
import { buildServer } from "../src/server.mjs";
import { fakePublisher } from "../src/social/routes.mjs";
import { hashPassword, verifyPassword, passwordProblem } from "../src/auth.mjs";
import { loadConfig } from "../src/config.mjs";
import { run as runCli } from "../src/staff-cli.mjs";

const PW = "correct horse battery";
const GOOD = "FIXTURE: seasonal tune-ups are $129. Call (415) 555-0100 to book.";
const SHARED = "t".repeat(40);

async function setup({ mode = "users", pubs } = {}) {
  const { db, close } = await newDb();
  let clock = T0;
  const gbp = fakePublisher();
  const app = await buildServer({
    db, staffToken: mode === "shared" ? SHARED : null, staffMode: mode, scryptN: 1024, now: () => clock,
    socialDeps: { catalog: fixtureCatalog(), publishers: pubs ?? { gbp, facebook: fakePublisher(), instagram: fakePublisher(), youtube: fakePublisher() } },
  });
  const call = async (method, url, payload, token) => {
    const r = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    let json = null; try { json = r.json(); } catch { /* not json */ }
    return { status: r.statusCode, json, raw: r };
  };
  const mk = (email, role, name = email) => app.staffAuth.createUser({ email, displayName: name, role, password: PW });
  const login = async (email, password = PW) => call("POST", "/api/auth/login", { email, password });
  const tok = async (email) => (await login(email)).json.token;
  const advance = (ms) => (clock = new Date(clock.getTime() + ms));
  return { db, app, gbp, call, mk, login, tok, advance, close: async () => { await app.close(); await close(); } };
}

test("users mode: no token, the old shared token, and a garbage token are all refused on every staff area", async () => {
  const s = await setup();
  await s.mk("alice@example.org", "staff");
  for (const url of ["/api/staff/me", "/api/staff/leads/1", "/api/staff/social/posts"]) {
    assert.equal((await s.call("GET", url)).status, 401, url);
    assert.equal((await s.call("GET", url, undefined, SHARED)).status, 401, `${url} shared token`);
    assert.equal((await s.call("GET", url, undefined, "x".repeat(43))).status, 401, `${url} garbage`);
  }
  await s.close();
});

test("login: wrong password, unknown user, disabled user all give the same answer; success returns a working session", async () => {
  const s = await setup();
  await s.mk("alice@example.org", "staff", "Alice A");
  const a = await s.login("alice@example.org", "wrong password here");
  const b = await s.login("nobody@example.org");
  assert.equal(a.status, 401);
  assert.deepEqual(a.json, b.json, "no account enumeration");
  assert.equal(a.json.error, "request_error");
  const ok = await s.login("  Alice@Example.org ");
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token.length >= 43);
  assert.equal(ok.json.user.role, "staff");
  assert.equal(JSON.stringify(ok.json).includes("password"), false);
  const me = await s.call("GET", "/api/staff/me", undefined, ok.json.token);
  assert.equal(me.json.user.email, "alice@example.org");
  assert.equal(me.json.user.displayName, "Alice A");
  await s.close();
});

test("the database never holds a raw session token or a plain password", async () => {
  const s = await setup();
  await s.mk("alice@example.org", "staff");
  const t = await s.tok("alice@example.org");
  const dump = JSON.stringify([
    (await s.db.query("SELECT * FROM staff_sessions")).rows, (await s.db.query("SELECT * FROM staff_users")).rows, (await s.db.query("SELECT * FROM staff_auth_events")).rows,
  ]);
  assert.equal(dump.includes(t), false);
  assert.equal(dump.includes(PW), false);
  assert.match((await s.db.query("SELECT password_hash FROM staff_users")).rows[0].password_hash, /^scrypt\$1024\$8\$1\$/);
  await s.close();
});

test("lockout: five failures lock the account, even the right password fails until the lock lapses", async () => {
  const s = await setup();
  await s.mk("alice@example.org", "staff");
  for (let i = 0; i < 5; i++) assert.equal((await s.login("alice@example.org", `bad password ${i} xx`)).status, 401);
  const locked = await s.login("alice@example.org");
  assert.equal(locked.status, 401, "correct password refused while locked");
  s.advance(16 * 60_000);
  assert.equal((await s.login("alice@example.org")).status, 200);
  const evs = (await s.db.query("SELECT event FROM staff_auth_events ORDER BY id")).rows.map((r) => r.event);
  assert.ok(evs.includes("login_locked") && evs.includes("login_ok"));
  await s.close();
});

test("a failed run resets after a good login (failures must be consecutive)", async () => {
  const s = await setup();
  await s.mk("alice@example.org", "staff");
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 4; i++) await s.login("alice@example.org", "bad password xxxx");
    assert.equal((await s.login("alice@example.org")).status, 200, `round ${r}`);
  }
  await s.close();
});

test("sessions expire (absolute 12h and idle 60 min), and logout revokes at once", async () => {
  const s = await setup();
  await s.mk("alice@example.org", "staff");
  const t1 = await s.tok("alice@example.org");
  s.advance(59 * 60_000);
  assert.equal((await s.call("GET", "/api/staff/me", undefined, t1)).status, 200, "active within idle window (refreshes last seen)");
  s.advance(59 * 60_000);
  assert.equal((await s.call("GET", "/api/staff/me", undefined, t1)).status, 200);
  s.advance(61 * 60_000);
  assert.equal((await s.call("GET", "/api/staff/me", undefined, t1)).status, 401, "idle too long");

  const t2 = await s.tok("alice@example.org");
  for (let i = 0; i < 14; i++) { s.advance(55 * 60_000); await s.call("GET", "/api/staff/me", undefined, t2); }
  assert.equal((await s.call("GET", "/api/staff/me", undefined, t2)).status, 401, "past 12h absolute even though never idle");

  const t3 = await s.tok("alice@example.org");
  assert.equal((await s.call("POST", "/api/staff/logout", {}, t3)).status, 200);
  assert.equal((await s.call("GET", "/api/staff/me", undefined, t3)).status, 401);
  await s.close();
});

test("disabling a user kills their sessions immediately; they cannot log in again", async () => {
  const s = await setup();
  const admin = await s.mk("root@example.org", "admin");
  const alice = await s.mk("alice@example.org", "staff");
  const ta = await s.tok("alice@example.org");
  const tr = await s.tok("root@example.org");
  assert.equal((await s.call("POST", `/api/staff/users/${alice.id}/disable`, {}, tr)).status, 200);
  assert.equal((await s.call("GET", "/api/staff/me", undefined, ta)).status, 401);
  assert.equal((await s.login("alice@example.org")).status, 401);
  assert.equal((await s.call("POST", `/api/staff/users/${admin.id}/disable`, {}, tr)).status, 400, "cannot disable yourself");
  await s.close();
});

test("password change: needs the current password, signs out other sessions, keeps this one; reset signs out everywhere", async () => {
  const s = await setup();
  await s.mk("alice@example.org", "staff");
  const a = await s.tok("alice@example.org");
  const b = await s.tok("alice@example.org");
  assert.equal((await s.call("POST", "/api/staff/password", { currentPassword: "nope nope nope", newPassword: "another long passphrase" }, a)).status, 401);
  assert.equal((await s.call("POST", "/api/staff/password", { currentPassword: PW, newPassword: "short" }, a)).status, 400);
  assert.equal((await s.call("POST", "/api/staff/password", { currentPassword: PW, newPassword: "another long passphrase" }, a)).status, 200);
  assert.equal((await s.call("GET", "/api/staff/me", undefined, a)).status, 200, "this session stays");
  assert.equal((await s.call("GET", "/api/staff/me", undefined, b)).status, 401, "other session is gone");
  assert.equal((await s.login("alice@example.org")).status, 401, "old password no longer works");
  assert.equal((await s.login("alice@example.org", "another long passphrase")).status, 200);

  await s.app.staffAuth.setPassword("alice@example.org", "third long passphrase!");
  assert.equal((await s.call("GET", "/api/staff/me", undefined, a)).status, 401, "reset signs out everywhere");
  await s.close();
});

test("admin routes: only admins; weak passwords and duplicates refused; listing never shows hashes", async () => {
  const s = await setup();
  await s.mk("root@example.org", "admin");
  await s.mk("bob@example.org", "approver");
  const tr = await s.tok("root@example.org");
  const tb = await s.tok("bob@example.org");
  assert.equal((await s.call("GET", "/api/staff/users", undefined, tb)).status, 403);
  assert.equal((await s.call("POST", "/api/staff/users", { email: "c@example.org", displayName: "C", role: "staff", password: PW }, tb)).status, 403);
  const body = { email: "carol@example.org", displayName: "Carol", role: "staff", password: PW };
  assert.equal((await s.call("POST", "/api/staff/users", body, tr)).status, 201);
  assert.equal((await s.call("POST", "/api/staff/users", body, tr)).status, 409);
  assert.equal((await s.call("POST", "/api/staff/users", { ...body, email: "d@example.org", password: "aaaaaaaaaaaa" }, tr)).status, 400, "repetitive");
  assert.equal((await s.call("POST", "/api/staff/users", { ...body, email: "e@example.org", password: "short" }, tr)).status, 400);
  assert.equal((await s.call("POST", "/api/staff/users", { ...body, email: "not-an-email" }, tr)).status, 400);
  assert.equal((await s.call("POST", "/api/staff/users", { ...body, email: "f@example.org", role: "owner" }, tr)).status, 400);
  const list = await s.call("GET", "/api/staff/users", undefined, tr);
  assert.equal(list.json.users.length, 3);
  assert.equal(list.raw.body.includes("scrypt"), false);
  await s.close();
});

test("social: staff can draft and submit but not approve, reject, publish or grant consent; approver can", async () => {
  const s = await setup();
  await s.mk("alice@example.org", "staff");
  await s.mk("bob@example.org", "approver");
  const ta = await s.tok("alice@example.org");
  const tb = await s.tok("bob@example.org");
  const P = (u, b, t) => s.call("POST", `/api/staff/social${u}`, b, t);

  assert.equal((await P("/connections", { platform: "gbp", scope: ["post"] }, ta)).status, 403);
  assert.equal((await P("/connections", { platform: "gbp", scope: ["post"] }, tb)).status, 201);

  const post = (await P("/posts", { platform: "gbp", kind: "update", content: GOOD }, ta)).json.post;
  assert.equal(post.created_by_id ?? post.createdById ?? "alice@example.org", "alice@example.org");
  assert.equal((await P(`/posts/${post.id}/submit`, {}, ta)).status, 200);
  assert.equal((await P(`/posts/${post.id}/approve`, {}, ta)).status, 403, "staff role cannot approve");
  assert.equal((await P(`/posts/${post.id}/reject`, {}, ta)).status, 403);
  assert.equal((await P(`/posts/${post.id}/publish`, {}, ta)).status, 403);
  assert.equal((await P(`/posts/${post.id}/approve`, {}, tb)).status, 200);
  assert.equal((await P(`/posts/${post.id}/publish`, {}, ta)).status, 403);
  assert.equal((await P(`/posts/${post.id}/publish`, {}, tb)).status, 200);
  assert.equal(s.gbp.calls.length, 1);

  const ev = (await s.call("GET", `/api/staff/social/posts/${post.id}/events`, undefined, tb)).json.events;
  const who = JSON.stringify(ev);
  assert.ok(who.includes("alice@example.org") && who.includes("bob@example.org"), "real identities in the audit trail");
  await s.close();
});

test("two-person rule is now real: an approver cannot approve their own post, and nobody can claim to be someone else", async () => {
  const s = await setup();
  await s.mk("bob@example.org", "approver");
  await s.mk("dana@example.org", "approver");
  await s.mk("alice@example.org", "staff");
  const tb = await s.tok("bob@example.org");
  const td = await s.tok("dana@example.org");
  const ta = await s.tok("alice@example.org");
  const P = (u, b, t) => s.call("POST", `/api/staff/social${u}`, b, t);
  await P("/connections", { platform: "gbp", scope: ["post"] }, tb);

  const post = (await P("/posts", { platform: "gbp", kind: "update", content: GOOD }, tb)).json.post;
  await P(`/posts/${post.id}/submit`, {}, tb);
  const self = await P(`/posts/${post.id}/approve`, {}, tb);
  assert.ok(self.status >= 400, `self approval refused (${self.status})`);
  // bob cannot say he is dana
  const spoof = await P(`/posts/${post.id}/approve`, { actor: { type: "user", id: "dana@example.org" } }, tb);
  assert.equal(spoof.status, 403);
  assert.equal(spoof.json.message, "actor does not match the signed-in user");
  // an agent actor is not accepted through a staff session
  assert.equal((await P(`/posts/${post.id}/approve`, { actor: { type: "agent", id: "social-agent" } }, td)).status, 403);
  // a correctly stated own identity is fine, and a second person can approve
  assert.equal((await P(`/posts/${post.id}/approve`, { actor: { type: "user", id: "dana@example.org" } }, td)).status, 200);
  // alice (staff) spoofing is refused before role is even considered for body content
  assert.equal((await P("/posts", { platform: "gbp", kind: "update", content: GOOD, actor: { type: "user", id: "bob@example.org" } }, ta)).status, 403);
  await s.close();
});

test("lead transition: the actor is the signed-in user, not the request body", async () => {
  const s = await setup();
  await s.mk("alice@example.org", "staff");
  const ta = await s.tok("alice@example.org");
  const lead = await s.call("POST", "/api/staff/leads", { type: "B2C", channel: "call", phone: "(415) 555-0100", serviceLine: "repair" }, ta);
  assert.equal(lead.status, 201, JSON.stringify(lead.json));
  const spoof = await s.call("POST", `/api/staff/leads/${lead.json.id}/transition`, { to: "contacted", actor: { type: "user", id: "someone-else" } }, ta);
  assert.equal(spoof.status, 403);
  const ok = await s.call("POST", `/api/staff/leads/${lead.json.id}/transition`, { to: "contacted" }, ta);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const rows = (await s.db.query("SELECT actor_type, actor_id FROM lead_events WHERE event_type <> 'lead_created' AND actor_id = 'alice@example.org'")).rows;
  assert.ok(rows.length >= 1);
  await s.close();
});

test("auth events are recorded and cannot be altered", async () => {
  const s = await setup();
  await s.mk("alice@example.org", "staff");
  await s.login("alice@example.org", "wrong password here");
  const t = await s.tok("alice@example.org");
  await s.call("POST", "/api/staff/logout", {}, t);
  const evs = (await s.db.query("SELECT event, ip FROM staff_auth_events ORDER BY id")).rows;
  assert.deepEqual(evs.map((e) => e.event), ["user_created", "login_failed", "login_ok", "logout"]);
  await assert.rejects(s.db.query("UPDATE staff_auth_events SET event = 'login_ok'"));
  await assert.rejects(s.db.query("DELETE FROM staff_auth_events"));
  await s.close();
});

test("login is rate limited per IP", async () => {
  const s = await setup();
  let last;
  for (let i = 0; i < 12; i++) last = await s.login("nobody@example.org", "whatever password");
  assert.equal(last.status, 429);
  await s.close();
});

test("shared mode is unchanged: no login routes, shared token works, body actor still required, no roles", async () => {
  const s = await setup({ mode: "shared" });
  assert.equal((await s.login("a@example.org")).status, 404);
  assert.equal((await s.call("GET", "/api/staff/social/posts", undefined, SHARED)).status, 200);
  assert.equal((await s.call("GET", "/api/staff/social/posts", undefined, "nope")).status, 401);
  const noActor = await s.call("POST", "/api/staff/social/connections", { platform: "gbp", scope: ["post"] }, SHARED);
  assert.equal(noActor.status, 400);
  const ok = await s.call("POST", "/api/staff/social/connections", { platform: "gbp", scope: ["post"], actor: { type: "user", id: "alice" } }, SHARED);
  assert.equal(ok.status, 201);
  await s.close();
});

test("config: STAFF_AUTH_MODE is validated; the shared token is only required (and only used) in shared mode", () => {
  const base = { DATABASE_URL: "postgres://x" };
  assert.throws(() => loadConfig(base), /STAFF_API_TOKEN/);
  assert.throws(() => loadConfig({ ...base, STAFF_AUTH_MODE: "sso" }), /STAFF_AUTH_MODE/);
  const u = loadConfig({ ...base, STAFF_AUTH_MODE: "users", STAFF_API_TOKEN: "t".repeat(40) });
  assert.equal(u.staffMode, "users");
  assert.equal(u.staffToken, null, "the shared token is ignored in users mode");
  assert.equal(loadConfig({ ...base, STAFF_AUTH_MODE: "users" }).staffMode, "users");
  assert.equal(loadConfig({ ...base, STAFF_API_TOKEN: "t".repeat(40) }).staffMode, "shared");
});

test("password hashing: round trip, wrong password, malformed and out-of-range hashes are false, policy", async () => {
  const h = await hashPassword(PW, { N: 1024 });
  assert.equal(await verifyPassword(PW, h), true);
  assert.equal(await verifyPassword("wrong", h), false);
  assert.notEqual(h, await hashPassword(PW, { N: 1024 }), "salted");
  for (const bad of ["", null, "scrypt$1$8$1$aa$bb", "scrypt$1024$8$1$$", "md5$x", `scrypt$${2 ** 25}$8$1$AAAA$AAAA`, "scrypt$1500$8$1$AAAA$AAAA"]) assert.equal(await verifyPassword(PW, bad), false, String(bad));
  assert.match(passwordProblem("short"), /12/);
  assert.match(passwordProblem("a@example.org", "a@example.org") ?? "", /./);
  assert.equal(passwordProblem(PW, "x@example.org"), null);
  assert.match(passwordProblem("abababababab"), /repetitive/);
});

test("cli: creates the first admin, resets, disables, lists; password only from the environment", async () => {
  const { db, close } = await newDb();
  const out = [];
  const say = (m) => out.push(m);
  await assert.rejects(runCli(db, ["create-user", "root@example.org", "admin", "Root User"], {}, say), /STAFF_NEW_PASSWORD/);
  await runCli(db, ["create-user", "Root@Example.org", "admin", "Root", "User"], { STAFF_NEW_PASSWORD: PW }, say);
  await assert.rejects(runCli(db, ["create-user", "root@example.org", "admin", "Dup"], { STAFF_NEW_PASSWORD: PW }, say), /already exists/);
  await runCli(db, ["set-password", "root@example.org"], { STAFF_NEW_PASSWORD: "a brand new passphrase" }, say);
  const users = await runCli(db, ["list"], {}, say);
  assert.equal(users[0].displayName, "Root User");
  await runCli(db, ["disable", "root@example.org"], {}, say);
  assert.equal((await runCli(db, ["list"], {}, say))[0].disabled, true);
  assert.equal(out.join("\n").includes(PW), false, "never echoes a password");
  await assert.rejects(runCli(db, ["nonsense"], {}, say), /commands/);
  await close();
});

test("defence in depth: the guard itself refuses a disabled user even if their sessions were not revoked", async () => {
  const s = await setup();
  await s.mk("alice@example.org", "staff");
  const t = await s.tok("alice@example.org");
  await s.db.query("UPDATE staff_users SET disabled_at = $1", [T0]);
  assert.equal((await s.call("GET", "/api/staff/me", undefined, t)).status, 401);
  await s.close();
});

test("role gate is what blocks a staff-role account from approving someone else's post (not the self-approval rule)", async () => {
  const s = await setup();
  await s.mk("bob@example.org", "approver");
  await s.mk("alice@example.org", "staff");
  const tb = await s.tok("bob@example.org");
  const ta = await s.tok("alice@example.org");
  const P = (u, b, t) => s.call("POST", `/api/staff/social${u}`, b, t);
  const post = (await P("/posts", { platform: "gbp", kind: "update", content: GOOD }, tb)).json.post;
  await P(`/posts/${post.id}/submit`, {}, tb);
  const r = await P(`/posts/${post.id}/approve`, {}, ta);
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "forbidden");
  await s.close();
});
