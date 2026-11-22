import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseOrigins } from "../src/config.mjs";

const base = { DATABASE_URL: "postgres://x", STAFF_API_TOKEN: "t".repeat(40) };

test("minimal env: agent off (fail closed), defaults applied", () => {
  const c = loadConfig(base);
  assert.equal(c.llm, null);
  assert.equal(c.port, 8787);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.trustProxy, false);
  assert.deepEqual(c.corsOrigins, []);
  assert.equal(c.chatRetentionDays, 30);
  assert.equal(c.crm, null);
});

test("ollama config is validated and defaults to loopback", () => {
  const c = loadConfig({ ...base, LLM_PROVIDER: "ollama", OLLAMA_MODEL: "llama3.1" });
  assert.deepEqual(c.llm, { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "llama3.1", timeoutMs: 20000, allowRemoteHttp: false });
});

test("every problem is reported at once", () => {
  try {
    loadConfig({ STAFF_API_TOKEN: "short", LLM_PROVIDER: "openai", CORS_ORIGINS: "*", PORT: "99999", CHAT_RETENTION_DAYS: "0" });
    assert.fail("should throw");
  } catch (e) {
    for (const k of ["DATABASE_URL", "STAFF_API_TOKEN", "LLM_PROVIDER", "CORS_ORIGINS", "PORT", "CHAT_RETENTION_DAYS"]) assert.match(e.message, new RegExp(k), k);
  }
});

test("ollama needs a model, a safe url and a sane timeout", () => {
  assert.throws(() => loadConfig({ ...base, LLM_PROVIDER: "ollama" }), /OLLAMA_MODEL/);
  assert.throws(() => loadConfig({ ...base, LLM_PROVIDER: "ollama", OLLAMA_MODEL: "m", OLLAMA_URL: "http://10.1.2.3:11434" }), /loopback/);
  assert.doesNotThrow(() => loadConfig({ ...base, LLM_PROVIDER: "ollama", OLLAMA_MODEL: "m", OLLAMA_URL: "https://ollama.example" }));
  assert.throws(() => loadConfig({ ...base, LLM_PROVIDER: "ollama", OLLAMA_MODEL: "m", LLM_TIMEOUT_MS: "5" }), /LLM_TIMEOUT_MS/);
});

test("CORS origins must be exact bare origins", () => {
  assert.deepEqual(parseOrigins("https://a.example, http://localhost:4321"), ["https://a.example", "http://localhost:4321"]);
  assert.deepEqual(parseOrigins("https://a.example/"), ["https://a.example"]);
  assert.deepEqual(parseOrigins(""), []);
  for (const bad of ["*", "https://a.example/path", "ftp://a.example", "a.example", "https://a.example, *"]) assert.throws(() => parseOrigins(bad), /CORS_ORIGINS|origin/i, bad);
});
