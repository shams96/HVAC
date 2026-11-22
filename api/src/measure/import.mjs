import { parseCsv } from "./csv.mjs";
import { ENGINES, getPanel } from "./panel.mjs";

export class ImportError extends Error {
  constructor(errors) {
    super(`Import rejected (nothing was saved):\n - ${errors.slice(0, 25).join("\n - ")}${errors.length > 25 ? `\n - ...and ${errors.length - 25} more` : ""}`);
    this.errors = errors;
  }
}

export function parseMonth(raw) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])(?:-01)?$/.exec(String(raw ?? "").trim());
  if (!m) throw new Error(`Invalid month "${raw}" (use YYYY-MM)`);
  return `${m[1]}-${m[2]}-01`;
}

const BOOL = new Map([["true", true], ["yes", true], ["1", true], ["y", true], ["false", false], ["no", false], ["0", false], ["n", false]]);
const parseBool = (v) => BOOL.get(String(v).trim().toLowerCase());
const needColumns = (header, cols) => { const miss = cols.filter((c) => !header.includes(c)); if (miss.length) throw new ImportError([`Missing column(s): ${miss.join(", ")}`]); };
const parseCount = (v) => { const s = String(v).replace(/,/g, "").trim(); return /^\d+$/.test(s) ? Number(s) : null; };

export function hostOf(url) {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("not http(s)");
  return u.hostname.toLowerCase().replace(/^www\./, "");
}

// ---- panel results ----
export async function importPanelResults(db, csvText, { versionId, runBy, method = "manual", now = new Date() }) {
  if (!runBy?.trim()) throw new ImportError(["run_by is required (who ran the queries)"]);
  if (!["manual", "official_api"].includes(method)) throw new ImportError(["method must be manual or official_api"]);
  const { header, rows } = parseCsv(csvText);
  needColumns(header, ["run_month", "engine", "query_id", "appeared", "position", "our_cited", "cited_urls", "evidence_ref"]);
  const panel = await getPanel(db, versionId);
  const queryIds = new Set(panel.queries.map((q) => q.id));
  const errors = [];
  const parsed = [];
  const seen = new Set();
  for (const r of rows) {
    const at = `Line ${r.line}`;
    let month, domains = [], urls = [];
    try { month = parseMonth(r.run_month); } catch (e) { errors.push(`${at}: ${e.message}`); continue; }
    if (!ENGINES.includes(r.engine)) errors.push(`${at}: unknown engine "${r.engine}" (allowed: ${ENGINES.join(", ")})`);
    const qid = parseCount(r.query_id);
    if (qid === null || !queryIds.has(qid)) errors.push(`${at}: query_id "${r.query_id}" is not in panel version ${versionId}`);
    const appeared = parseBool(r.appeared), cited = parseBool(r.our_cited);
    if (appeared === undefined) errors.push(`${at}: appeared must be yes or no`);
    if (cited === undefined) errors.push(`${at}: our_cited must be yes or no`);
    let position = null;
    if (r.position !== "") {
      position = parseCount(r.position);
      if (position === null || position < 1 || position > 100) errors.push(`${at}: position must be 1 to 100 or empty`);
      else if (appeared === false) errors.push(`${at}: a position needs appeared = yes`);
    }
    if (!r.evidence_ref) errors.push(`${at}: evidence_ref is required (screenshot name, saved answer, or link)`);
    if (r.cited_urls) {
      for (const raw of r.cited_urls.split(";").map((s) => s.trim()).filter(Boolean)) {
        try { domains.push(hostOf(raw)); urls.push(raw); } catch { errors.push(`${at}: cited URL "${raw.slice(0, 80)}" is not a valid http(s) URL`); }
      }
    }
    const key = `${r.run_month}|${r.engine}|${r.query_id}`;
    if (seen.has(key)) errors.push(`${at}: duplicate row for the same month, engine and query`);
    seen.add(key);
    parsed.push({ month, engine: r.engine, qid, appeared, position, cited, urls, domains: [...new Set(domains)], evidence: r.evidence_ref });
  }
  if (errors.length) throw new ImportError(errors);

  return db.transaction(async (tx) => {
    const groups = new Map();
    for (const p of parsed) {
      const k = `${p.month}|${p.engine}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    const summary = [];
    for (const [k, items] of groups) {
      const [month, engine] = k.split("|");
      let run = (await tx.query("SELECT id, completed_at FROM panel_runs WHERE version_id = $1 AND run_month = $2::date AND engine = $3", [versionId, month, engine])).rows[0];
      if (run?.completed_at) throw new ImportError([`The ${engine} run for ${month.slice(0, 7)} is already complete and immutable`]);
      if (!run) {
        run = (await tx.query("INSERT INTO panel_runs (version_id, run_month, engine, method, run_by, started_at) VALUES ($1, $2::date, $3, $4, $5, $6::timestamptz) RETURNING id", [versionId, month, engine, method, runBy.trim(), now.toISOString()])).rows[0];
      }
      const existing = new Set((await tx.query("SELECT query_id FROM panel_results WHERE run_id = $1", [run.id])).rows.map((x) => Number(x.query_id)));
      const dupes = items.filter((p) => existing.has(p.qid)).map((p) => p.qid);
      if (dupes.length) throw new ImportError([`${engine} ${month.slice(0, 7)}: results already recorded for query ids ${dupes.join(", ")}`]);
      for (const p of items) {
        await tx.query(
          `INSERT INTO panel_results (run_id, query_id, our_appeared, our_position, our_cited, cited_urls, cited_domains, evidence_ref, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::timestamptz)`,
          [run.id, p.qid, p.appeared, p.position, p.cited, JSON.stringify(p.urls), JSON.stringify(p.domains), p.evidence, now.toISOString()]
        );
      }
      const have = Number((await tx.query("SELECT count(*)::int AS n FROM panel_results WHERE run_id = $1", [run.id])).rows[0].n);
      const complete = have === panel.queries.length;
      if (complete) await tx.query("UPDATE panel_runs SET completed_at = $2::timestamptz WHERE id = $1", [run.id, now.toISOString()]);
      summary.push({ month: month.slice(0, 7), engine, inserted: items.length, recorded: have, of: panel.queries.length, completed: complete });
    }
    return summary;
  });
}

// ---- Search Console "Pages" export (one calendar month) ----
const ZIP_PAGE = /\/service-area\/(?:[a-z0-9-]+-)?(\d{5})\/?$/i;

export async function importGscPages(db, csvText, { month, batch = "gsc", now = new Date() }) {
  const periodStart = parseMonth(month);
  const { header, rows } = parseCsv(csvText);
  const pageCol = ["Top pages", "Page", "Pages", "page"].find((c) => header.includes(c));
  if (!pageCol) throw new ImportError(['Missing the page column ("Top pages" in a Search Console Pages export)']);
  needColumns(header, ["Clicks", "Impressions"]);
  const errors = [];
  const agg = new Map(); // "zip|12345" or "page|/path" -> {clicks, impressions}
  for (const r of rows) {
    const at = `Line ${r.line}`;
    const clicks = parseCount(r.Clicks), imps = parseCount(r.Impressions);
    if (clicks === null || imps === null) { errors.push(`${at}: Clicks and Impressions must be whole numbers`); continue; }
    if (clicks > imps) { errors.push(`${at}: clicks (${clicks}) exceed impressions (${imps})`); continue; }
    let path;
    try { path = new URL(r[pageCol], "https://placeholder.invalid").pathname; } catch { errors.push(`${at}: page "${r[pageCol].slice(0, 60)}" is not a URL or path`); continue; }
    const m = ZIP_PAGE.exec(path);
    const key = m ? `zip|${m[1]}` : `page|${path.slice(0, 200)}`;
    const cur = agg.get(key) ?? { clicks: 0, impressions: 0 };
    cur.clicks += clicks; cur.impressions += imps;
    agg.set(key, cur);
  }
  if (errors.length) throw new ImportError(errors);
  return db.transaction(async (tx) => {
    let zipRows = 0, pageRows = 0;
    for (const [key, v] of agg) {
      const [dim, val] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
      dim === "zip" ? zipRows++ : pageRows++;
      for (const metric of ["clicks", "impressions"]) {
        await tx.query(
          `INSERT INTO metrics (source, metric, period_start, dim_type, dim_value, value, import_batch, imported_at) VALUES ('gsc', $1, $2::date, $3, $4, $5, $6, $7::timestamptz)
           ON CONFLICT (source, metric, period_start, dim_type, dim_value) DO UPDATE SET value = EXCLUDED.value, import_batch = EXCLUDED.import_batch, imported_at = EXCLUDED.imported_at`,
          [metric, periodStart, dim, val, v[metric], batch, now.toISOString()]
        );
      }
    }
    return { month: periodStart.slice(0, 7), zipRows, pageRows };
  });
}

// ---- generic monthly metrics (GBP, analytics, call tracking, manual) ----
const ALLOWED = {
  gsc: ["clicks", "impressions"],
  gbp: ["calls", "direction_requests", "website_clicks", "bookings", "messages"],
  analytics: ["sessions", "form_submissions", "phone_clicks", "booking_clicks"],
  call_tracking: ["calls", "answered_calls", "missed_calls"],
  manual: null,
};

export async function importMetrics(db, csvText, { source, batch = source, now = new Date() }) {
  if (!(source in ALLOWED)) throw new ImportError([`Unknown source "${source}" (allowed: ${Object.keys(ALLOWED).join(", ")})`]);
  const { header, rows } = parseCsv(csvText);
  needColumns(header, ["month", "metric", "dimension_type", "dimension_value", "value"]);
  const errors = [];
  const parsed = [];
  for (const r of rows) {
    const at = `Line ${r.line}`;
    let month; try { month = parseMonth(r.month); } catch (e) { errors.push(`${at}: ${e.message}`); continue; }
    const allowed = ALLOWED[source];
    if (allowed ? !allowed.includes(r.metric) : !/^[a-z_]{2,40}$/.test(r.metric)) errors.push(`${at}: metric "${r.metric}" is not valid for source ${source}${allowed ? ` (allowed: ${allowed.join(", ")})` : ""}`);
    if (!["zip", "branch", "page", "site"].includes(r.dimension_type)) errors.push(`${at}: dimension_type must be zip, branch, page or site`);
    if (r.dimension_type === "zip" && !/^\d{5}$/.test(r.dimension_value)) errors.push(`${at}: a zip dimension needs a 5 digit ZIP`);
    if (r.dimension_type === "site" && r.dimension_value !== "") errors.push(`${at}: a site dimension takes no value`);
    const value = Number(String(r.value).replace(/,/g, ""));
    if (!Number.isFinite(value) || value < 0 || String(r.value).trim() === "") errors.push(`${at}: value must be a number of 0 or more`);
    parsed.push({ month, metric: r.metric, dim: r.dimension_type, val: r.dimension_value.slice(0, 200), value });
  }
  if (errors.length) throw new ImportError(errors);
  return db.transaction(async (tx) => {
    for (const p of parsed) {
      await tx.query(
        `INSERT INTO metrics (source, metric, period_start, dim_type, dim_value, value, import_batch, imported_at) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8::timestamptz)
         ON CONFLICT (source, metric, period_start, dim_type, dim_value) DO UPDATE SET value = EXCLUDED.value, import_batch = EXCLUDED.import_batch, imported_at = EXCLUDED.imported_at`,
        [source, p.metric, p.month, p.dim, p.val, p.value, batch, now.toISOString()]
      );
    }
    return { rows: parsed.length };
  });
}

// ---- ad spend (dollars as text, stored as integer cents: no floating point money) ----
export function dollarsToCents(raw) {
  const m = /^\$?\s*(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(raw).replace(/,/g, "").trim());
  if (!m) throw new Error(`Invalid amount "${raw}" (use dollars, for example 500 or 1250.50)`);
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

export async function recordSpend(db, { month, channel, amount, note = null, now = new Date() }) {
  const m = parseMonth(month);
  if (!channel?.trim()) throw new Error("channel is required");
  const cents = dollarsToCents(amount);
  await db.query(
    `INSERT INTO ad_spend (month, channel, amount_cents, note, created_at) VALUES ($1::date, $2, $3, $4, $5::timestamptz)
     ON CONFLICT (month, channel) DO UPDATE SET amount_cents = EXCLUDED.amount_cents, note = EXCLUDED.note`,
    [m, channel.trim(), cents, note, now.toISOString()]
  );
  return { month: m.slice(0, 7), channel: channel.trim(), cents };
}
