import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { newDb, T0, minutes, seedRoutes } from "./helpers.mjs";
import { buildServer } from "../src/server.mjs";
import { drainOutbox, sign } from "../src/crm/outbox.mjs";
import { sweepSlaBreaches, anonymizeExpired, transitionLead } from "../src/repo/leads.mjs";

const TOKEN = "t".repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };

async function setup(opts = {}) {
  const { db, close } = await newDb();
  await seedRoutes(db);
  let clock = T0;
  const app = await buildServer({ db, staffToken: TOKEN, now: () => clock, ...opts });
  return { db, app, setClock: (d) => (clock = d), close: async () => { await app.close(); await close(); } };
}
const post = (app, url, payload, headers = {}) => app.inject({ method: "POST", url, payload, headers });
const form = (o = {}) => ({ type: "B2C", channel: "form", name: "Sample Person", phone: "(415) 555-0100", email: "sample@example.org", zip: "00001", serviceLine: "repair", consents: [{ channel: "sms", wordingVersion: "v1" }], ...o });

test("E2E sample leads: intake > dedupe > route > SLA > stages > opt-out > CRM, with a full audit trail", async () => {
  const { db, app, setClock, close } = await setup();

  // 1. residential form lead, routed by ZIP
  const r1 = await post(app, "/api/leads", form());
  assert.equal(r1.statusCode, 201);
  const id1 = r1.json().id;

  // 2. same person calls (different phone format), attaches instead of duplicating
  setClock(minutes(3));
  const r2 = await post(app, "/api/staff/leads", form({ channel: "call", phone: "+1 415 555 0100", email: undefined, consents: [] }), auth);
  assert.equal(r2.json().deduped, true);
  assert.equal(r2.json().id, id1);

  // 3. emergency call from a ZIP we do not serve -> unrouted, 15 min SLA
  const r3 = await post(app, "/api/staff/leads", form({ channel: "call", zip: "99999", phone: "(415) 555-0142", email: "gas@example.org", emergency: true, consents: [] }), auth);
  const lead3 = (await app.inject({ method: "GET", url: `/api/staff/leads/${r3.json().id}`, headers: auth })).json();
  assert.equal(lead3.lead.routed_by, "unrouted");
  assert.equal(lead3.lead.branch_id, null);

  // 4. commercial lead with sites
  const r4 = await post(app, "/api/leads", {
    type: "B2B", channel: "form", name: "Pat Manager", phone: "(415) 555-0150", email: "pat@propco.example", zip: "00001", serviceLine: "maintenance-agreement",
    b2b: { company: "PropCo Sample LLC", kind: "property_management", role: "Facilities Manager", sites: [{ label: "Building A", zip: "00001" }] },
  });
  assert.equal(r4.statusCode, 201);
  const id4 = r4.json().id;

  // 5. SLA sweep 20 min after the emergency came in: emergency breached, others not yet
  setClock(minutes(25));
  const breached = await sweepSlaBreaches(db, minutes(25));
  assert.deepEqual(breached, [r3.json().id]);

  // 6. staff work the residential lead; actor recorded each time
  for (const [i, to] of ["contacted", "booked", "won"].entries()) {
    setClock(minutes(30 + i));
    const t = await post(app, `/api/staff/leads/${id1}/transition`, { to, actor: { type: "user", id: "dispatcher-1" } }, auth);
    assert.equal(t.statusCode, 200, t.body);
  }
  const bad = await post(app, `/api/staff/leads/${id1}/transition`, { to: "lost", reason: "x", actor: { type: "user", id: "d" } }, auth);
  assert.equal(bad.statusCode, 409, "terminal lead cannot move");

  // 7. B2B walks Lead > Site visit > Quote > Negotiation > Won, one step skipped is refused
  const skip = await post(app, `/api/staff/leads/${id4}/transition`, { to: "quote", actor: { type: "user", id: "sales-1" } }, auth);
  assert.equal(skip.statusCode, 409);
  for (const to of ["site_visit", "quote", "negotiation", "won"]) {
    const t = await post(app, `/api/staff/leads/${id4}/transition`, { to, actor: { type: "user", id: "sales-1" } }, auth);
    assert.equal(t.statusCode, 200, t.body);
  }

  // 8. customer opts out of texts; the sample person's consent flips immediately
  const out = await post(app, "/api/opt-out", { phone: "415-555-0100", channel: "sms" });
  assert.equal(out.statusCode, 200);
  const c1 = (await app.inject({ method: "GET", url: `/api/staff/leads/${id1}`, headers: auth })).json();
  const consent = (await db.query("SELECT channel, status FROM consent_records WHERE contact_id = $1 ORDER BY id", [c1.contact.id])).rows;
  assert.deepEqual(consent.map((c) => `${c.channel}:${c.status}`), ["sms:granted", "sms:revoked"]);

  // 9. audit trail: ordered, every stage change has a who
  const trail = c1.events.map((e) => `${e.event_type}${e.to_stage ? ">" + e.to_stage : ""}:${e.actor_type}`);
  assert.deepEqual(trail, ["lead_created>new:customer", "inquiry_attached:customer", "stage_changed>contacted:user", "stage_changed>booked:user", "stage_changed>won:user"]);

  // 10. CRM receives every event exactly once, signed, with consent flags
  const received = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { received.push({ headers: req.headers, body }); res.writeHead(200).end("ok"); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/hook`;
  const secret = "s".repeat(32);
  const total = (await db.query("SELECT count(*)::int AS n FROM crm_outbox")).rows[0].n;
  const res = await drainOutbox(db, { url, secret, now: minutes(60), allowInsecure: true, batch: 500 });
  assert.equal(res.sent, total);
  assert.equal(received.length, total);
  for (const r of received) assert.equal(r.headers["x-signature"], sign(secret, r.body), "signature verifies");
  const p = JSON.parse(received[0].body);
  assert.equal(p.contact.phone, "+14155550100");
  assert.equal(p.consent.sms === false || p.consent.sms === true, true);
  assert.equal((await drainOutbox(db, { url, secret, now: minutes(61), allowInsecure: true })).sent, 0, "nothing sent twice");
  srv.close();
  await close();
});

test("CRM outbox: failures back off, give up after max attempts, and recover when the CRM is back", async () => {
  const { db, app, close } = await setup();
  await post(app, "/api/leads", form());
  let status = 500;
  const hits = [];
  const fakeFetch = async (_u, o) => { hits.push(o.headers["Idempotency-Key"]); return { ok: status === 200, status }; };
  const cfg = { url: "https://crm.example/hook", secret: "s".repeat(32), fetchImpl: fakeFetch, maxAttempts: 3 };
  assert.deepEqual(await drainOutbox(db, { ...cfg, now: T0 }), { sent: 0, retried: 1, failed: 0 });
  assert.equal((await drainOutbox(db, { ...cfg, now: T0 })).retried, 0, "not due yet (backoff)");
  assert.equal((await drainOutbox(db, { ...cfg, now: minutes(3) })).retried, 1);
  status = 200;
  assert.deepEqual(await drainOutbox(db, { ...cfg, now: minutes(10) }), { sent: 1, retried: 0, failed: 0 });
  assert.equal(new Set(hits).size, 1, "same idempotency key on every retry");

  await post(app, "/api/leads", form({ phone: "(415) 555-0199", email: "z@example.org" }));
  status = 500;
  await drainOutbox(db, { ...cfg, now: minutes(20) });
  await drainOutbox(db, { ...cfg, now: minutes(30) });
  const last = await drainOutbox(db, { ...cfg, now: minutes(60) });
  assert.equal(last.failed, 1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM crm_outbox WHERE status = 'failed'")).rows[0].n, 1);

  await assert.rejects(drainOutbox(db, { ...cfg, url: "http://crm.example/hook" }), /https/);
  await assert.rejects(drainOutbox(db, { ...cfg, secret: "short" }), /secret/);
  await close();
});

test("CRM payload carries no PII once a contact is anonymized", async () => {
  const { db, app, close } = await setup();
  const old = new Date("2023-01-01T00:00:00Z");
  const r = await post(app, "/api/leads", form({ phone: "(415) 555-0190", email: "old@example.org" }));
  await db.query("UPDATE leads SET created_at = $1", [old.toISOString()]);
  await transitionLead(db, r.json().id, "lost", { type: "user", id: "u" }, { reason: "no answer", now: old });
  assert.equal(await anonymizeExpired(db, T0), 1);
  let body;
  await drainOutbox(db, { url: "https://crm.example/h", secret: "s".repeat(32), now: T0, fetchImpl: async (_u, o) => { body = JSON.parse(o.body); return { ok: true, status: 200 }; } });
  assert.deepEqual([body.contact.name, body.contact.phone, body.contact.email], [null, null, null]);
  await close();
});

test("staff API: no token, wrong token, and unconfigured auth are all refused", async () => {
  const { app, close } = await setup();
  assert.equal((await app.inject({ method: "GET", url: "/api/staff/leads/1" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/staff/leads/1", headers: { authorization: "Bearer wrong" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/staff/leads/1", headers: { authorization: "Basic abc" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/staff/leads/999", headers: auth })).statusCode, 404);
  assert.equal((await post(app, "/api/staff/leads", form())).statusCode, 401);
  await close();
  const off = await setup({ staffToken: undefined });
  assert.equal((await off.app.inject({ method: "GET", url: "/api/staff/leads/1", headers: auth })).statusCode, 503);
  await off.close();
});

test("public intake: rate limit returns 429 after the cap", async () => {
  const { app, close } = await setup({ intakeLimit: 5 });
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await post(app, "/api/leads", form({ phone: `(415) 555-02${10 + i}`, email: `r${i}@example.org` }))).statusCode);
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 429, 429]);
  await close();
});

test("public intake: validation, honeypot, and channel restriction", async () => {
  const { db, app, close } = await setup({ intakeLimit: 100 });
  assert.equal((await post(app, "/api/leads", { type: "B2C" })).statusCode, 400);
  assert.equal((await post(app, "/api/leads", form({ zip: "123" }))).statusCode, 400);
  assert.equal((await post(app, "/api/leads", form({ serviceLine: "DROP TABLE" }))).statusCode, 400);
  assert.equal((await post(app, "/api/leads", form({ channel: "call" }))).statusCode, 400, "call leads come from call tracking, not the public form");
  assert.equal((await post(app, "/api/leads", form({ phone: "nope", email: "nope" }))).statusCode, 400);
  const bot = await post(app, "/api/leads", form({ website: "http://spam.example" }));
  assert.equal(bot.statusCode, 201);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM leads")).rows[0].n, 0, "honeypot stores nothing");
  await close();
});

test("errors do not leak internals", async () => {
  const { db, app, close } = await setup();
  await db.exec("DROP TABLE crm_outbox CASCADE");
  const r = await post(app, "/api/leads", form());
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.json(), { error: "internal_error", message: "Something went wrong" });
  await close();
});

test("rate limit keys on the real client IP only when trustProxy is on", async () => {
  const hit = (app, ip, i) => app.inject({ method: "POST", url: "/api/leads", headers: { "x-forwarded-for": ip }, payload: form({ phone: `(415) 555-03${10 + i}`, email: `p${i}@example.org` }) });
  const trusted = await setup({ intakeLimit: 2, trustProxy: true });
  const a = [await hit(trusted.app, "203.0.113.1", 0), await hit(trusted.app, "203.0.113.1", 1), await hit(trusted.app, "203.0.113.1", 2), await hit(trusted.app, "203.0.113.2", 3)];
  assert.deepEqual(a.map((r) => r.statusCode), [201, 201, 429, 201], "per-client limits behind a trusted proxy");
  await trusted.close();
  const direct = await setup({ intakeLimit: 2, trustProxy: false });
  const b = [await hit(direct.app, "203.0.113.1", 0), await hit(direct.app, "203.0.113.2", 1), await hit(direct.app, "203.0.113.3", 2)];
  assert.deepEqual(b.map((r) => r.statusCode), [201, 201, 429], "spoofed X-Forwarded-For cannot dodge the limit when not behind a proxy");
  await direct.close();
});
