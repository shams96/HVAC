// Monthly report: what appeared, which sources were cited, what search and GBP reported, what the funnel did.
// By design there is NO combined visibility score: results are counts and facts per engine, per query, per ZIP.
import { ENGINES, getPanel } from "./panel.mjs";
import { parseMonth } from "./import.mjs";

const num = (v) => (v == null ? null : Number(v));
const addMonth = (d, n) => { const [y, m] = d.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-01`; };
const ratio = (a, b) => (b > 0 ? a / b : null);

async function runsFor(db, versionId, month) {
  const runs = (await db.query(
    `SELECT r.id, r.engine, r.method, r.run_by, r.completed_at,
            count(x.id)::int AS recorded,
            count(*) FILTER (WHERE x.our_appeared)::int AS appeared,
            count(*) FILTER (WHERE x.our_cited)::int AS cited
       FROM panel_runs r LEFT JOIN panel_results x ON x.run_id = r.id
      WHERE r.version_id = $1 AND r.run_month = $2::date GROUP BY r.id ORDER BY r.engine`,
    [versionId, month]
  )).rows;
  return runs.map((r) => ({ id: Number(r.id), engine: r.engine, method: r.method, runBy: r.run_by, completed: !!r.completed_at, recorded: r.recorded, appeared: r.appeared, cited: r.cited }));
}

async function resultsFor(db, runIds) {
  if (!runIds.length) return [];
  return (await db.query(
    "SELECT run_id, query_id, our_appeared, our_position, our_cited, cited_domains, evidence_ref FROM panel_results WHERE run_id = ANY($1::bigint[])",
    [runIds]
  )).rows;
}

export async function buildReport(db, { month, versionId = null, ourDomain = null, fixture = false, now = new Date() }) {
  const start = parseMonth(month);
  const end = addMonth(start, 1);
  const prev = addMonth(start, -1);
  const caveats = [];

  // ---- panel ----
  const vid = versionId ?? (await db.query("SELECT id FROM panel_versions ORDER BY id DESC LIMIT 1")).rows[0]?.id ?? null;
  let panelSection = null;
  if (vid == null) {
    caveats.push("No query panel exists yet. Create one from the approved catalog.");
  } else {
    const panel = await getPanel(db, Number(vid));
    const runs = await runsFor(db, Number(vid), start);
    const prevRuns = await runsFor(db, Number(vid), prev);
    const rows = await resultsFor(db, runs.map((r) => r.id));
    const prevRows = await resultsFor(db, prevRuns.map((r) => r.id));
    const byRun = (arr) => new Map(arr.map((r) => [Number(r.id), r.engine]));
    const runEngine = byRun(runs), prevEngine = byRun(prevRuns);
    const cell = new Map(); // `${queryId}|${engine}` -> result
    for (const r of rows) cell.set(`${r.query_id}|${runEngine.get(Number(r.run_id))}`, r);
    const prevCell = new Map();
    for (const r of prevRows) prevCell.set(`${r.query_id}|${prevEngine.get(Number(r.run_id))}`, r);
    const engines = ENGINES.filter((e) => runs.some((r) => r.engine === e));

    const queries = panel.queries.map((q) => {
      const per = {};
      for (const e of engines) {
        const c = cell.get(`${q.id}|${e}`);
        if (!c) { per[e] = { recorded: false }; continue; }
        const p = prevCell.get(`${q.id}|${e}`);
        per[e] = {
          recorded: true, appeared: c.our_appeared, position: c.our_position, cited: c.our_cited, evidence: c.evidence_ref,
          change: !p ? "no previous result" : p.our_appeared === c.our_appeared ? "same" : c.our_appeared ? "gained" : "lost",
        };
      }
      return { position: q.position, query: q.text, zip: q.zip, serviceLine: q.serviceLine, intent: q.intent, engines: per };
    });

    const domainCount = new Map();
    for (const r of rows) for (const d of r.cited_domains ?? []) domainCount.set(d, (domainCount.get(d) ?? 0) + 1);
    const citedDomains = [...domainCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15)
      .map(([domain, answers]) => ({ domain, answers, ours: !!ourDomain && domain === ourDomain.toLowerCase().replace(/^www\./, "") }));

    panelSection = {
      version: panel.version.label, size: panel.queries.length,
      engines: runs.map((r) => ({ engine: r.engine, method: r.method, runBy: r.runBy, completed: r.completed, recorded: r.recorded, of: panel.queries.length, appeared: r.appeared, cited: r.cited })),
      queries, citedDomains,
    };
    if (!runs.length) caveats.push(`No panel runs are recorded for ${start.slice(0, 7)}.`);
    for (const r of runs) if (!r.completed) caveats.push(`The ${r.engine} run is incomplete (${r.recorded} of ${panel.queries.length} queries recorded).`);
    if (runs.length && !prevRuns.length) caveats.push("There is no previous month to compare with yet.");
  }

  // ---- imported metrics ----
  const metricRows = (await db.query("SELECT source, metric, dim_type, dim_value, value, period_start FROM metrics WHERE period_start IN ($1::date, $2::date)", [start, prev])).rows;
  const at = (m) => new Date(m.period_start).toISOString().slice(0, 10);
  const zipMap = new Map();
  for (const m of metricRows.filter((x) => x.source === "gsc" && x.dim_type === "zip")) {
    const z = zipMap.get(m.dim_value) ?? { zip: m.dim_value, impressions: null, clicks: null, prevImpressions: null, prevClicks: null };
    const cur = at(m) === start;
    z[cur ? m.metric : `prev${m.metric[0].toUpperCase()}${m.metric.slice(1)}`] = num(m.value);
    zipMap.set(m.dim_value, z);
  }
  const searchByZip = [...zipMap.values()].sort((a, b) => a.zip.localeCompare(b.zip)).map((z) => ({ ...z, ctr: z.impressions ? ratio(z.clicks ?? 0, z.impressions) : null }));
  if (!searchByZip.length) caveats.push("No Search Console data was imported for this month. Search Console has no ZIP field, so ZIP figures come from each ZIP page's URL.");
  const other = metricRows.filter((x) => at(x) === start && !(x.source === "gsc" && x.dim_type === "zip"))
    .map((x) => ({ source: x.source, metric: x.metric, dimension: x.dim_type === "site" ? "site" : `${x.dim_type} ${x.dim_value}`, value: num(x.value) }))
    .sort((a, b) => (a.source + a.metric + a.dimension).localeCompare(b.source + b.metric + b.dimension));
  if (!other.some((x) => x.source === "gbp")) caveats.push("No Business Profile actions (calls, direction requests, website clicks) were imported for this month.");

  // ---- funnel (cohort: leads created in the month) ----
  const funnelRows = (await db.query(
    `SELECT COALESCE(l.zip, '(none)') AS zip,
            count(*)::int AS leads,
            count(*) FILTER (WHERE l.channel = 'call')::int AS calls,
            count(*) FILTER (WHERE l.channel = 'form')::int AS forms,
            count(*) FILTER (WHERE l.channel = 'chat')::int AS chats,
            count(*) FILTER (WHERE l.channel = 'booking')::int AS bookings,
            count(*) FILTER (WHERE l.type = 'B2B')::int AS b2b,
            count(*) FILTER (WHERE l.routed_by = 'unrouted')::int AS unrouted,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = l.id AND e.to_stage IN ('booked', 'won')))::int AS jobs
       FROM leads l WHERE l.created_at >= $1::date AND l.created_at < $2::date GROUP BY 1 ORDER BY 1`,
    [start, end]
  )).rows;
  const sum = (k) => funnelRows.reduce((a, r) => a + r[k], 0);
  const totals = { leads: sum("leads"), calls: sum("calls"), forms: sum("forms"), chats: sum("chats"), bookings: sum("bookings"), b2b: sum("b2b"), unrouted: sum("unrouted"), jobs: sum("jobs") };
  const spend = (await db.query("SELECT COALESCE(sum(amount_cents), 0)::bigint AS cents, count(*)::int AS n FROM ad_spend WHERE month = $1::date", [start])).rows[0];
  const spendCents = Number(spend.n) ? Number(spend.cents) : null;
  const funnel = {
    cohortNote: "Leads created in the month; a job is a lead that reached booked or won (at any time so far).",
    totals: { ...totals, leadToJobRate: ratio(totals.jobs, totals.leads), spendCents, costPerJobCents: spendCents != null && totals.jobs > 0 ? Math.round(spendCents / totals.jobs) : null },
    byZip: funnelRows.map((r) => ({ ...r, leadToJobRate: ratio(r.jobs, r.leads) })),
  };
  if (!totals.leads) caveats.push("No leads were created in this month.");
  else if (totals.leads < 20) caveats.push(`Only ${totals.leads} leads this month: rates from small counts swing a lot, so read them as counts.`);
  if (spendCents == null) caveats.push("No ad spend was entered for this month, so cost per booked job is not available.");
  else if (totals.jobs === 0) caveats.push("Ad spend exists but there are no booked jobs yet, so cost per booked job is not available (not zero).");
  if (totals.unrouted > 0) caveats.push(`${totals.unrouted} lead(s) were unrouted: no routing rule covers their ZIP and service.`);
  caveats.push("Calls count only leads that came in as calls. Call tracking data is not connected yet.");
  caveats.push("Panel results are what a person recorded on the day. Answers vary by location, time and personalization, so treat month to month changes as signals, not proof.");

  return {
    month: start.slice(0, 7), generatedAt: now.toISOString(), fixture,
    panel: panelSection, search: { byZip: searchByZip, other }, funnel, caveats,
  };
}
