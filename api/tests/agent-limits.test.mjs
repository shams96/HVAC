import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, post, startChat, send, count, logEvents, say, call, tools, estimateArgs, always } from "./agent-helpers.mjs";
import { purgeChats } from "../src/agent/index.mjs";
import { minutes, T0 } from "./helpers.mjs";

test("A10: message length, emptiness and type are enforced (2000 chars ok, 2001 refused, nothing stored when refused)", async () => {
  const t = await setup({ script: [say("Happy to help.")] });
  const token = await startChat(t.app);
  assert.equal((await send(t.app, token, "x".repeat(2000))).statusCode, 200);
  assert.equal((await send(t.app, token, "x".repeat(2001))).statusCode, 400);
  assert.equal((await send(t.app, token, "")).statusCode, 400);
  assert.equal((await post(t.app, "/api/chat/message", { token })).statusCode, 400);
  assert.equal((await post(t.app, "/api/chat/message", { token, text: { a: 1 } })).statusCode, 400);
  // only invisible characters: cleans to empty, refused by the agent itself
  assert.equal((await send(t.app, token, "​​‮")).statusCode, 400);
  assert.equal(await count(t.db, "chat_messages", "role = 'user'"), 1, "only the valid message was stored");
  assert.equal(t.llm.calls.length, 1);
  // 4-byte characters stay within the route body limit
  assert.equal((await send(t.app, token, "\u{1F600}".repeat(1000))).statusCode, 200);
  await t.close();
});

test("A10: oversized and malformed request bodies are refused before any work happens", async () => {
  const t = await setup({ script: [say("hi")] });
  const token = await startChat(t.app);
  const big = await t.app.inject({ method: "POST", url: "/api/chat/message", payload: { token, text: "x".repeat(20_000) } });
  assert.equal(big.statusCode, 413);
  const bad = await t.app.inject({ method: "POST", url: "/api/chat/message", headers: { "content-type": "application/json" }, payload: "{not json" });
  assert.equal(bad.statusCode, 400);
  const huge = await t.app.inject({ method: "POST", url: "/api/chat/confirm", payload: { token, actionId: "a", consents: Array.from({ length: 500 }, () => ({ channel: "sms" })) } });
  assert.ok([400, 413].includes(huge.statusCode));
  assert.equal((await post(t.app, "/api/chat/message", { token, text: "ok", extra: "ignored" })).statusCode, 200);
  assert.equal(t.llm.calls.length, 1);
  assert.equal(bad.json().error, "request_error");
  await t.close();
});

test("A10: the turn limit is enforced atomically, including under concurrency, and stops model calls", async () => {
  const t = await setup({ script: [say("ok")], agentOpts: { maxTurns: 3 } });
  const token = await startChat(t.app);
  const codes = (await Promise.all([1, 2, 3, 4, 5, 6].map((i) => send(t.app, token, `hello ${i}`)))).map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [200, 200, 200, 429, 429, 429]);
  assert.equal(t.llm.calls.length, 3, "no model call past the cap");
  assert.equal((await t.db.query("SELECT turns FROM conversations")).rows[0].turns, 3);
  assert.equal((await send(t.app, token, "one more")).json().error, "turn_limit");
  await t.close();
});

test("A10: the conversation TTL ends messages and confirmations; the token is useless afterwards", async () => {
  const t = await setup({ script: always(call("request_estimate", estimateArgs())), agentOpts: { conversationTtlMin: 30, actionTtlMin: 60 } });
  const token = await startChat(t.app);
  const id = (await send(t.app, token, "estimate")).json().pendingActions[0].id;
  const before = t.llm.calls.length;
  t.setClock(minutes(31));
  const late = await send(t.app, token, "hello again");
  assert.equal(late.statusCode, 410);
  assert.equal(t.llm.calls.length, before, "no model call after expiry");
  const c = await post(t.app, "/api/chat/confirm", { token, actionId: id });
  assert.equal(c.statusCode, 410);
  assert.equal(await count(t.db, "leads"), 0, "action was still within its own TTL, but the conversation was not");
  await t.close();
});

test("A10: public routes are rate limited per route (429 after the cap) and start is tighter than message", async () => {
  const t = await setup({ script: [say("ok")], agentOpts: { limits: { start: 3, message: 4, confirm: 2, reject: 2 } } });
  const starts = [];
  for (let i = 0; i < 5; i++) starts.push((await post(t.app, "/api/chat/start", {})).statusCode);
  assert.deepEqual(starts, [201, 201, 201, 429, 429]);
  const token = (await t.agent.start()).token;
  const msgs = [];
  for (let i = 0; i < 6; i++) msgs.push((await send(t.app, token, "hi")).statusCode);
  assert.deepEqual(msgs, [200, 200, 200, 200, 429, 429]);
  const conf = [];
  for (let i = 0; i < 4; i++) conf.push((await post(t.app, "/api/chat/confirm", { token, actionId: "00000000-0000-4000-8000-000000000000" })).statusCode);
  assert.deepEqual(conf, [409, 409, 429, 429]);
  await t.close();
});

test("start: tokens are random, long, returned once, and stored only as a hash; a fixed AI disclosure is included", async () => {
  const t = await setup();
  const a = (await post(t.app, "/api/chat/start", {})).json();
  const b = (await post(t.app, "/api/chat/start", {})).json();
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(a.greeting, /automated assistant/);
  assert.match(a.greeting, /911/);
  const stored = JSON.stringify((await t.db.query("SELECT * FROM conversations")).rows);
  assert.ok(!stored.includes(a.token) && !stored.includes(b.token), "raw token is never stored");
  const r = await post(t.app, "/api/chat/message", { token: a.token.slice(0, 42) + (a.token.endsWith("A") ? "B" : "A"), text: "hi" });
  assert.equal(r.statusCode, 401);
  assert.equal((await post(t.app, "/api/chat/message", { token: "short", text: "hi" })).statusCode, 400);
  const resp = await post(t.app, "/api/chat/start", {});
  assert.equal(resp.headers["cache-control"], "no-store");
  await t.close();
});

test("A12: purgeChats deletes message text past retention but keeps rows; recent chats survive; action details are scrubbed", async () => {
  const t = await setup({ script: always(call("request_estimate", estimateArgs()), "ok") });
  const token = await startChat(t.app);
  await send(t.app, token, "My furnace at 12 Elm Street is dead, secret-word-OLD");
  t.setClock(minutes(60 * 24 * 40)); // 40 days later
  const token2 = await startChat(t.app);
  await send(t.app, token2, "recent message secret-word-NEW");
  const r = await purgeChats(t.db, minutes(60 * 24 * 40), { days: 30 });
  assert.ok(r.messages >= 2, "old user + assistant text purged");
  const rows = (await t.db.query("SELECT role, content, purged_at FROM chat_messages ORDER BY id")).rows;
  const old = rows.slice(0, 2);
  assert.ok(old.every((m) => m.content === null && m.purged_at), "old text gone");
  assert.ok(rows.slice(2).every((m) => m.content !== null && !m.purged_at), "recent text kept");
  assert.equal(await count(t.db, "chat_messages"), rows.length, "rows (counts, ids, timing) retained");
  assert.ok(!JSON.stringify((await t.db.query("SELECT * FROM chat_messages")).rows).includes("secret-word-OLD"));
  // the first conversation's still-pending proposal expired and was scrubbed; purge is idempotent
  assert.deepEqual(await purgeChats(t.db, minutes(60 * 24 * 40), { days: 30 }), { messages: 0, actions: 0 });
  await assert.rejects(purgeChats(t.db, T0, { days: -1 }), /non-negative/);
  await assert.rejects(purgeChats(t.db, T0, { days: NaN }), /non-negative/);
  await t.close();
});

test("A12: resolved actions hold no contact details, and logs/errors/server logs never contain message text", async () => {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return orig(chunk, ...rest); };
  let t;
  try {
    t = await setup({
      script: (req) => {
        if (req.messages.at(-1).content.includes("boom-phrase")) throw new Error("upstream failure while handling boom-phrase");
        return req.messages.some((m) => m.role === "tool") ? say("ok") : tools(call("request_estimate", estimateArgs()));
      },
      serverOpts: { logger: true },
    });
    const token = await startChat(t.app);
    const id = (await send(t.app, token, "private-phrase-ALPHA estimate please")).json().pendingActions[0].id;
    await post(t.app, "/api/chat/confirm", { token, actionId: id, consents: [{ channel: "sms" }] });
    const boom = await send(t.app, token, "boom-phrase with private-phrase-BETA");
    assert.equal(boom.statusCode, 200);
    assert.ok(!boom.body.includes("boom-phrase"));
    await send(t.app, token, "x".repeat(5000));
  } finally {
    process.stdout.write = orig;
  }
  const out = lines.join("");
  assert.ok(out.length > 0, "the server did log requests (so the check below is meaningful)");
  for (const s of ["private-phrase", "boom-phrase", "555-0100", "sample@example.org", "Sample Person"]) assert.ok(!out.includes(s), `server log leaked ${s}`);
  const row = (await t.db.query("SELECT args, summary, status FROM pending_actions")).rows[0];
  assert.equal(row.status, "confirmed");
  assert.deepEqual(row.args, {});
  assert.equal(row.summary, "[removed]");
  const logs = JSON.stringify((await t.db.query("SELECT * FROM agent_actions_log")).rows);
  for (const s of ["private-phrase", "boom-phrase", "555-0100", "sample@example.org"]) assert.ok(!logs.includes(s));
  await t.close();
});

test("direct createAgent use matches the HTTP behaviour (same refusals, same single-use confirm)", async () => {
  const t = await setup({ script: always(call("request_estimate", estimateArgs())) });
  const { token } = await t.agent.start();
  const r = await t.agent.message(token, "estimate");
  const id = r.pendingActions[0].id;
  const out = await t.agent.confirm(token, id, [{ channel: "email", wordingVersion: "v2" }]);
  assert.equal(out.ok, true);
  assert.ok(out.leadId > 0);
  await assert.rejects(t.agent.confirm(token, id), (e) => e.code === "confirmation_refused" && e.status === 409);
  await assert.rejects(t.agent.confirm(token, "nope"), (e) => e.code === "confirmation_refused");
  await assert.rejects(t.agent.message("bad", "x"), (e) => e.status === 401);
  await assert.rejects(t.agent.confirm(token, id, [{ channel: "pigeon" }]), (e) => e.code === "invalid_consents");
  assert.equal(await count(t.db, "leads"), 1);
  await t.close();
});

test("a customer's own estimate flow end to end with consent, dedupe against an existing lead and the CRM outbox", async () => {
  const t = await setup({ script: always(call("request_estimate", estimateArgs())) });
  const token = await startChat(t.app);
  const id = (await send(t.app, token, "estimate")).json().pendingActions[0].id;
  await post(t.app, "/api/chat/confirm", { token, actionId: id, consents: [{ channel: "call", wordingVersion: "v1" }] });
  // the same customer asks again in a new conversation: attaches to the open lead, no duplicate
  const tok2 = await startChat(t.app);
  const id2 = (await send(t.app, tok2, "estimate again")).json().pendingActions[0].id;
  await post(t.app, "/api/chat/confirm", { token: tok2, actionId: id2 });
  assert.equal(await count(t.db, "leads"), 1);
  assert.ok((await count(t.db, "crm_outbox")) >= 2);
  assert.equal(await count(t.db, "lead_events", "actor_type = 'agent' AND actor_id = 'chat-agent'"), 2);
  await t.close();
});
