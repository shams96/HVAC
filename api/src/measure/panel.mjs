// Fixed query panel: generated deterministically from the approved catalog, then frozen as a numbered version.
import { createHash } from "node:crypto";

export const ENGINES = ["google_search", "google_ai_overview", "bing_search", "bing_copilot", "chatgpt_search", "perplexity", "gemini"];

// Customer-style phrasings. Order matters: it is the rotation used to vary intent across ZIP and service combinations.
const TEMPLATES = [
  { intent: "local", make: ({ svc, city }) => `${svc} near me in ${city}` },
  { intent: "price", make: ({ svc, city }) => `how much does ${svc} cost in ${city}` },
  { intent: "urgent", make: ({ svc, city }) => `emergency ${svc} ${city}` },
  { intent: "trust", make: ({ svc, city }) => `best ${svc} company in ${city}` },
  { intent: "local", make: ({ svc, zip }) => `${svc} ${zip}` },
  { intent: "commercial", make: ({ svc, city }) => `commercial ${svc} ${city}` },
  { intent: "local", make: ({ svc, city, state }) => `${svc} in ${city} ${state}` },
  { intent: "trust", make: ({ svc, city }) => `who does ${svc} in ${city}` },
];

export const catalogHash = (catalog) =>
  createHash("sha256")
    .update(JSON.stringify({
      areas: [...catalog.areas].map((a) => [a.zip, a.city, a.state, [...a.serviceLines].sort()]).sort(),
      services: [...catalog.services].map((s) => [s.slug, s.searchTerm ?? s.name]).sort(),
    }))
    .digest("hex");

export function generatePanel(catalog, { size = 40 } = {}) {
  const svcBySlug = new Map(catalog.services.map((s) => [s.slug, s]));
  const combos = [];
  for (const a of [...catalog.areas].sort((x, y) => x.zip.localeCompare(y.zip))) {
    for (const slug of [...a.serviceLines].sort()) {
      const s = svcBySlug.get(slug);
      if (s) combos.push({ zip: a.zip, city: a.city, state: a.state, serviceLine: slug, svc: String(s.searchTerm ?? s.name).toLowerCase() });
    }
  }
  if (!combos.length) throw new Error("Cannot build a panel: the catalog has no ZIP and service combinations");
  const seen = new Set();
  const queries = [];
  for (let round = 0; round < TEMPLATES.length && queries.length < size; round++) {
    for (let k = 0; k < combos.length && queries.length < size; k++) {
      const c = combos[k];
      const t = TEMPLATES[(round + k) % TEMPLATES.length];
      const text = t.make(c).replace(/\s+/g, " ").trim();
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push({ position: queries.length + 1, text, zip: c.zip, serviceLine: c.serviceLine, intent: t.intent });
    }
  }
  if (queries.length < size) {
    throw new Error(`Cannot build a panel of ${size}: the catalog only supports ${queries.length} distinct queries. Add ZIP codes or services.`);
  }
  return { queries, catalogHash: catalogHash(catalog) };
}

export async function createPanelVersion(db, { label, catalog, size = 40, now = new Date() }) {
  if (!label?.trim()) throw new Error("A panel label is required");
  const panel = generatePanel(catalog, { size });
  return db.transaction(async (tx) => {
    const v = await tx.query("INSERT INTO panel_versions (label, catalog_hash, created_at) VALUES ($1, $2, $3::timestamptz) RETURNING id", [label.trim(), panel.catalogHash, now.toISOString()]);
    const id = Number(v.rows[0].id);
    for (const q of panel.queries) {
      await tx.query("INSERT INTO panel_queries (version_id, position, query_text, zip, service_line, intent) VALUES ($1, $2, $3, $4, $5, $6)", [id, q.position, q.text, q.zip, q.serviceLine, q.intent]);
    }
    return { id, label: label.trim(), size: panel.queries.length };
  });
}

export async function getPanel(db, versionId) {
  const v = (await db.query("SELECT id, label, catalog_hash, created_at FROM panel_versions WHERE id = $1", [versionId])).rows[0];
  if (!v) throw new Error(`Panel version ${versionId} not found`);
  const q = (await db.query("SELECT id, position, query_text, zip, service_line, intent FROM panel_queries WHERE version_id = $1 ORDER BY position", [versionId])).rows;
  return { version: { id: Number(v.id), label: v.label, catalogHash: v.catalog_hash }, queries: q.map((x) => ({ id: Number(x.id), position: x.position, text: x.query_text, zip: x.zip, serviceLine: x.service_line, intent: x.intent })) };
}
