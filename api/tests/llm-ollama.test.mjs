import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createOllamaLlm, checkOllamaUrl } from "../src/agent/llm-ollama.mjs";

// A fake Ollama written from the documented /api/chat shape. It is NOT a real Ollama (none is installed here).
async function fakeOllama(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      handler(req, res, seen);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}
const json = (res, obj, code = 200) => { res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj)); };

const TOOLS = [{ name: "check_coverage", description: "d", parameters: { type: "object", properties: { zip: { type: "string" } }, required: ["zip"] } }];

test("request mapping: system first, tool calls and tool results in Ollama's shape, stream off", async () => {
  const f = await fakeOllama((_q, res) => json(res, { message: { role: "assistant", content: "hello" } }));
  const llm = createOllamaLlm({ baseUrl: f.url, model: "m1" });
  const out = await llm.complete({
    system: "SYS",
    tools: TOOLS,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "check_coverage", args: { zip: "00001" } }] },
      { role: "tool", toolCallId: "c1", name: "check_coverage", content: "RESULT" },
    ],
  });
  assert.deepEqual(out, { text: "hello" });
  const b = f.seen[0].body;
  assert.equal(f.seen[0].url, "/api/chat");
  assert.equal(b.model, "m1");
  assert.equal(b.stream, false);
  assert.deepEqual(b.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(b.messages[0].content, "SYS");
  assert.deepEqual(b.messages[2].tool_calls, [{ function: { name: "check_coverage", arguments: { zip: "00001" } } }]);
  assert.equal(b.messages[3].tool_name, "check_coverage");
  assert.deepEqual(b.tools[0], { type: "function", function: { name: "check_coverage", description: "d", parameters: TOOLS[0].parameters } });
  await f.close();
});

test("response parsing: tool calls, string arguments, junk entries", async () => {
  const f = await fakeOllama((_q, res) => json(res, { message: { role: "assistant", content: "", tool_calls: [
    { function: { name: "check_coverage", arguments: { zip: "00001" } } },
    { function: { name: "list_services", arguments: "{\"a\":1}" } },
    { function: { name: "get_business_info", arguments: "not json" } },
    { function: { name: "x", arguments: "[1,2]" } },
    { function: { arguments: {} } },
    null,
  ] } }));
  const llm = createOllamaLlm({ baseUrl: f.url, model: "m" });
  const out = await llm.complete({ system: "s", messages: [], tools: [] });
  assert.deepEqual(out.toolCalls, [
    { name: "check_coverage", args: { zip: "00001" } },
    { name: "list_services", args: { a: 1 } },
    { name: "get_business_info", args: {} },
    { name: "x", args: {} },
  ]);
  await f.close();
});

test("failures throw (the agent turns a throw into its safe fallback)", async () => {
  const f500 = await fakeOllama((_q, res) => json(res, { error: "boom" }, 500));
  await assert.rejects(createOllamaLlm({ baseUrl: f500.url, model: "m" }).complete({ system: "s", messages: [] }), /HTTP 500/);
  await f500.close();
  const fbad = await fakeOllama((_q, res) => res.writeHead(200).end("<html>not json</html>"));
  await assert.rejects(createOllamaLlm({ baseUrl: fbad.url, model: "m" }).complete({ system: "s", messages: [] }));
  await fbad.close();
  const fnomsg = await fakeOllama((_q, res) => json(res, { done: true }));
  await assert.rejects(createOllamaLlm({ baseUrl: fnomsg.url, model: "m" }).complete({ system: "s", messages: [] }), /no message/);
  await fnomsg.close();
  const fredir = await fakeOllama((_q, res) => res.writeHead(302, { location: "http://evil.example/" }).end());
  await assert.rejects(createOllamaLlm({ baseUrl: fredir.url, model: "m" }).complete({ system: "s", messages: [] }), "redirects are refused");
  await fredir.close();
});

test("a slow server is aborted at the timeout", async () => {
  const f = await fakeOllama(() => { /* never answers */ });
  const llm = createOllamaLlm({ baseUrl: f.url, model: "m", timeoutMs: 150 });
  const t0 = Date.now();
  await assert.rejects(llm.complete({ system: "s", messages: [] }));
  assert.ok(Date.now() - t0 < 2000);
  await f.close();
});

test("URL and config rules: loopback http or https only; model required", () => {
  assert.doesNotThrow(() => checkOllamaUrl("http://127.0.0.1:11434"));
  assert.doesNotThrow(() => checkOllamaUrl("http://localhost:11434"));
  assert.doesNotThrow(() => checkOllamaUrl("https://ollama.internal.example"));
  assert.throws(() => checkOllamaUrl("http://10.0.0.5:11434"), /loopback/);
  assert.throws(() => checkOllamaUrl("http://ollama.example"), /loopback/);
  assert.throws(() => checkOllamaUrl("ftp://127.0.0.1"), /http/);
  assert.throws(() => checkOllamaUrl("not a url"), /Invalid/);
  assert.doesNotThrow(() => checkOllamaUrl("http://10.0.0.5:11434", { allowRemoteHttp: true }));
  assert.throws(() => createOllamaLlm({ baseUrl: "http://127.0.0.1:11434" }), /OLLAMA_MODEL/);
});
