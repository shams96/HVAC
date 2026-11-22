// LLM adapter for a local Ollama server (POST /api/chat). Local on purpose: chat text can contain names and phone
// numbers, so it should not leave the machine. Implements the agent's interface:
//   complete({ system, messages, tools }) -> { text?, toolCalls?: [{ id?, name, args }] }
// Anything unexpected throws; the agent turns a throw into its fixed safe fallback.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function checkOllamaUrl(raw, { allowRemoteHttp = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`Invalid OLLAMA_URL: ${raw}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("OLLAMA_URL must be http or https");
  if (u.protocol === "http:" && !LOOPBACK.has(u.hostname) && !allowRemoteHttp) {
    throw new Error("OLLAMA_URL over plain http must be loopback; use https for a remote server (chat text is personal data)");
  }
  return u;
}

const clean = (v) => (typeof v === "string" ? v : "");

function toOllamaMessages(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      out.push({
        role: "assistant",
        content: clean(m.content),
        tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args && typeof c.args === "object" ? c.args : {} } })),
      });
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_name: m.name, content: clean(m.content) });
    } else if (m.role === "user" || m.role === "assistant") {
      out.push({ role: m.role, content: clean(m.content) });
    }
  }
  return out;
}

const toOllamaTools = (tools) => (tools ?? []).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

function parseArgs(a) {
  if (a && typeof a === "object" && !Array.isArray(a)) return a;
  if (typeof a === "string") {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch { /* fall through */ }
  }
  return {};
}

export function createOllamaLlm({ baseUrl = "http://127.0.0.1:11434", model, fetchImpl = fetch, timeoutMs = 20_000, temperature = 0.2, allowRemoteHttp = false } = {}) {
  if (!model || typeof model !== "string") throw new Error("OLLAMA_MODEL is required");
  const url = new URL("/api/chat", checkOllamaUrl(baseUrl, { allowRemoteHttp }));
  return {
    async complete({ system, messages, tools }) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: false, messages: toOllamaMessages(system, messages), tools: toOllamaTools(tools), options: { temperature } }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
      const data = await res.json();
      const msg = data?.message;
      if (!msg || typeof msg !== "object") throw new Error("ollama response has no message");
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const toolCalls = calls
        .map((c) => ({ name: c?.function?.name, args: parseArgs(c?.function?.arguments) }))
        .filter((c) => typeof c.name === "string" && c.name.length > 0);
      return toolCalls.length ? { toolCalls } : { text: clean(msg.content) };
    },
  };
}
