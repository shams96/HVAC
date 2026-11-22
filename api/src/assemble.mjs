// Decides which optional modules run, from validated config. Pure enough to test; main.mjs only supplies real parts.
import { loadCatalog } from "./catalog.mjs";
import { createOllamaLlm } from "./agent/llm-ollama.mjs";
import { buildPublishers, configuredPlatforms } from "./social/registry.mjs";

export function assembleDeps(cfg, { env = {}, catalog = null, makeLlm = createOllamaLlm, makePublishers = buildPublishers } = {}) {
  const notes = [];
  const warnings = [];
  const cat = cfg.llm || cfg.social ? (catalog ?? loadCatalog()) : null;

  let agentDeps = null;
  if (cfg.llm) {
    const llm = makeLlm({ baseUrl: cfg.llm.baseUrl, model: cfg.llm.model, timeoutMs: cfg.llm.timeoutMs, allowRemoteHttp: cfg.llm.allowRemoteHttp });
    agentDeps = { catalog: cat, llm, availability: null, llmTimeoutMs: cfg.llm.timeoutMs + 2000 };
    notes.push(`chat agent enabled (model ${cfg.llm.model}; ${cat.services.length} services, ${cat.areas.length} ZIPs in catalog)`);
  } else {
    notes.push("chat agent disabled: set LLM_PROVIDER=ollama and OLLAMA_MODEL to enable it");
  }

  let socialDeps = null;
  if (cfg.social) {
    const publishers = makePublishers(env);
    const live = configuredPlatforms(publishers);
    socialDeps = { catalog: cat, publishers };
    notes.push(`social publishing enabled (staff routes under /api/staff/social); platforms able to publish: ${live.length ? live.join(", ") : "none, every publish will be refused with 503 until an adapter is registered"}`);
    warnings.push("social approvals rely on the shared staff token: the approver identity is asserted by the token holder, so two-person control is not enforced until per-user staff login exists");
    if (!cat.business.phoneE164 && !cat.services.length) warnings.push("the catalog is empty, so posts containing any price or phone number will be refused by the content policy");
  } else {
    notes.push("social publishing disabled: set SOCIAL_ENABLED=1 to enable it");
  }
  return { agentDeps, socialDeps, notes, warnings };
}
