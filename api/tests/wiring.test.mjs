import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { newDb, T0 } from "./helpers.mjs";
import { buildServer } from "../src/server.mjs";
import { createOllamaLlm } from "../src/agent/llm-ollama.mjs";
import { fixtureCatalog } from "./catalog-fixture.mjs";

const TOKEN = "t".repeat(40);
const ORIGIN = "https://site.example";

// Fake Ollama (documented /api/chat shape). Chooses its answer from the last message, like a very small model would.
async function fakeOllama() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      seen.push(b);
      const last = b.messages[b.messages.length - 1];
      let message;
      if (last.role === "tool") {
        message = { role: "assistant", content: last.tool_name === "request_estimate" ? "I have prepared your estimate request for you to review." : "Yes, we serve ZIP 00001 for repair." };
      } else if (/estimate/i.test(last.content)) {
        message = { role: "assistant", content: "", tool_calls: [{ function: { name: "request_estimate", arguments: { serviceLine: "repair", zip: "00001", name: "Sample Person", phone: "(415) 555-0100", email: "sample@example.org" } } }] };
      } else {
        message = { role: "assistant", content: "", tool_calls: [{ function: { name: "check_coverage", arguments: { zip: "00001", serviceLine: "repair" } } }] };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ message }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

async function boot(opts = {}) {
  const { db, close } = await newDb();
  const fake = await fakeOllama();
  const llm = createOllamaLlm({ baseUrl: fake.url, model: "test-model", timeoutMs: 5000 });
  let clock = T0;
  const app = await buildServer({ db, staffToken: TOKEN, now: () => clock, corsOrigins: [ORIGIN], agentDeps: { catalog: fixtureCatalog(), llm, availability: null }, ...opts });
  return { db, app, fake, setClock: (d) => (clock = d), close: async () => { await app.close(); await fake.close(); await close(); } };
}
const post = (app, url, payload, headers = {}) => app.inject({ method: "POST", url, payload, headers });

test("wired agent: a real chat through the Ollama adapter ends in a confirmed lead with consent from the checkbox only", async () => {
  const { db, app, fake, close } = await boot();
  const start = (await post(app, "/api/chat/start", {})).json();
  assert.ok(start.token && start.greeting);

  const m1 = await post(app, "/api/chat/message", { token: start.token, text: "Do you serve 00001?" });
  assert.equal(m1.statusCode, 200);
  assert.match(m1.json().reply, /we serve ZIP 00001/);

  const m2 = await post(app, "/api/chat/message", { token: start.token, text: "Please request an estimate for repair." });
  const body = m2.json();
  assert.equal(body.pendingActions.length, 1, "a proposal, not an executed action");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM leads")).rows[0].n, 0, "nothing created before the customer confirms");

  const confirm = await post(app, "/api/chat/confirm", { token: start.token, actionId: body.pendingActions[0].id, consents: [{ channel: "sms", wordingVersion: "v1" }] });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const lead = (await db.query("SELECT * FROM leads")).rows[0];
  assert.equal(lead.channel, "chat");
  assert.equal(lead.zip, "00001");
  const consent = (await db.query("SELECT channel, status, source FROM consent_records")).rows;
  assert.deepEqual(consent.map((c) => `${c.channel}:${c.status}`), ["sms:granted"]);

  // What the model was sent: customer text is wrapped as data, tools are offered, the conversation token is never sent.
  const everything = JSON.stringify(fake.seen);
  assert.ok(fake.seen.length >= 3);
  assert.match(everything, /<<DATA kind=customer/);
  assert.ok(fake.seen[0].tools.some((t) => t.function.name === "request_estimate"));
  assert.equal(everything.includes(start.token), false, "token never reaches the model");
  assert.equal(fake.seen[0].messages[0].role, "system");
  await close();
});

test("a model outage gives the customer the safe fallback, not an error page", async () => {
  const { db, close: closeAll } = await newDb();
  const llm = createOllamaLlm({ baseUrl: "http://127.0.0.1:1", model: "m", timeoutMs: 1000 }); // nothing listens on port 1
  const app = await buildServer({ db, staffToken: TOKEN, agentDeps: { catalog: fixtureCatalog(), llm, availability: null } });
  const start = (await post(app, "/api/chat/start", {})).json();
  const r = await post(app, "/api/chat/message", { token: start.token, text: "Do you serve 00001?" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().handoffOffered, true);
  await app.close();
  await closeAll();
});

test("emergency text is answered without calling the model at all", async () => {
  const { app, fake, close } = await boot();
  const { token } = (await post(app, "/api/chat/start", {})).json();
  const r = await post(app, "/api/chat/message", { token, text: "I smell gas in my kitchen" });
  assert.equal(r.json().emergency, true);
  assert.equal(fake.seen.length, 0, "no model call");
  await close();
});

test("CORS: only the configured website origin, POST only, and never the Authorization header", async () => {
  const { app, close } = await boot();
  const pre = (origin, headers) => app.inject({ method: "OPTIONS", url: "/api/chat/message", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": headers } });
  const ok = await pre(ORIGIN, "content-type");
  assert.equal(ok.headers["access-control-allow-origin"], ORIGIN);
  const bad = await pre("https://evil.example", "content-type");
  assert.equal(bad.headers["access-control-allow-origin"], undefined);
  const staff = await pre(ORIGIN, "authorization");
  assert.equal(/authorization/i.test(staff.headers["access-control-allow-headers"] ?? ""), false, "browsers cannot send the staff token cross-origin");
  const real = await post(app, "/api/chat/start", {}, { origin: ORIGIN });
  assert.equal(real.headers["access-control-allow-origin"], ORIGIN);
  const other = await post(app, "/api/chat/start", {}, { origin: "https://evil.example" });
  assert.equal(other.headers["access-control-allow-origin"], undefined);
  await close();
});

test("no agent configured: chat routes do not exist (fail closed) and app.agent is unset", async () => {
  const { db, close } = await newDb();
  const app = await buildServer({ db, staffToken: TOKEN });
  assert.equal((await post(app, "/api/chat/start", {})).statusCode, 404);
  assert.equal(app.agent, undefined);
  await app.close();
  await close();
});

test("app.agent.expireStale closes abandoned proposals (the background job's hook)", async () => {
  const { db, app, setClock, close } = await boot();
  const { token } = (await post(app, "/api/chat/start", {})).json();
  await post(app, "/api/chat/message", { token, text: "Do you serve 00001?" });
  const m = await post(app, "/api/chat/message", { token, text: "Please request an estimate for repair." });
  assert.equal(m.json().pendingActions.length, 1);
  setClock(new Date(T0.getTime() + 60 * 60_000));
  assert.ok(typeof app.agent.expireStale === "function");
  const n = await app.agent.expireStale();
  assert.equal(n, 1);
  assert.equal((await db.query("SELECT status FROM pending_actions")).rows[0].status, "expired");
  await close();
});
