// Environment -> validated config. Fails fast with every problem listed, and fails closed:
// no LLM_PROVIDER means the chat agent is simply not started (the rest of the API still runs).
import { checkOllamaUrl } from "./agent/llm-ollama.mjs";

export function parseOrigins(raw) {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((o) => {
    if (o === "*") throw new Error("CORS_ORIGINS must list exact origins, not *");
    let u;
    try { u = new URL(o); } catch { throw new Error(`CORS_ORIGINS has an invalid origin: ${o}`); }
    if (!["http:", "https:"].includes(u.protocol) || u.origin !== o.replace(/\/$/, "")) {
      throw new Error(`CORS_ORIGINS entries must be bare origins like https://example.com (got ${o})`);
    }
    return u.origin;
  });
}

export function loadConfig(env) {
  const problems = [];
  const need = (name, ok, msg) => { if (!ok) problems.push(`${name}: ${msg}`); };

  need("DATABASE_URL", !!env.DATABASE_URL, "required");
  need("STAFF_API_TOKEN", !!env.STAFF_API_TOKEN && env.STAFF_API_TOKEN.length >= 32, "required, at least 32 characters");

  let corsOrigins = [];
  try { corsOrigins = parseOrigins(env.CORS_ORIGINS); } catch (e) { problems.push(`CORS_ORIGINS: ${e.message}`); }

  let llm = null;
  const provider = env.LLM_PROVIDER?.trim();
  if (provider) {
    if (provider !== "ollama") problems.push(`LLM_PROVIDER: only "ollama" is supported (got "${provider}")`);
    else {
      need("OLLAMA_MODEL", !!env.OLLAMA_MODEL, "required when LLM_PROVIDER=ollama");
      const baseUrl = env.OLLAMA_URL || "http://127.0.0.1:11434";
      try { checkOllamaUrl(baseUrl, { allowRemoteHttp: env.OLLAMA_ALLOW_REMOTE_HTTP === "1" }); } catch (e) { problems.push(`OLLAMA_URL: ${e.message}`); }
      const timeoutMs = Number(env.LLM_TIMEOUT_MS ?? 20000);
      need("LLM_TIMEOUT_MS", Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 120000, "integer between 1000 and 120000");
      llm = { provider, baseUrl, model: env.OLLAMA_MODEL, timeoutMs, allowRemoteHttp: env.OLLAMA_ALLOW_REMOTE_HTTP === "1" };
    }
  }

  const chatRetentionDays = Number(env.CHAT_RETENTION_DAYS ?? 30);
  need("CHAT_RETENTION_DAYS", Number.isInteger(chatRetentionDays) && chatRetentionDays >= 1 && chatRetentionDays <= 3650, "integer between 1 and 3650");

  const port = Number(env.PORT ?? 8787);
  need("PORT", Number.isInteger(port) && port > 0 && port < 65536, "valid port");

  if (problems.length) throw new Error(`Invalid configuration:\n - ${problems.join("\n - ")}`);
  return {
    databaseUrl: env.DATABASE_URL,
    staffToken: env.STAFF_API_TOKEN,
    port,
    host: env.HOST ?? "127.0.0.1",
    trustProxy: env.TRUST_PROXY === "1",
    corsOrigins,
    crm: env.CRM_WEBHOOK_URL ? { url: env.CRM_WEBHOOK_URL, secret: env.CRM_WEBHOOK_SECRET } : null,
    llm,
    chatRetentionDays,
    social: env.SOCIAL_ENABLED === "1",
  };
}
