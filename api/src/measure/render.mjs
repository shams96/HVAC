// Self-contained HTML report: no scripts, no external requests, every dynamic value escaped.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (r) => (r == null ? "no data" : `${(r * 100).toFixed(1)}%`);
const n = (v) => (v == null ? "no data" : Number(v).toLocaleString("en-US"));
const money = (c) => (c == null ? "no data" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

const cellText = (c) => {
  if (!c || !c.recorded) return '<span class="muted">not recorded</span>';
  const parts = [c.appeared ? `Appeared${c.position ? ` (#${esc(c.position)})` : ""}` : "Not found"];
  if (c.cited) parts.push("cited");
  const change = c.change && c.change !== "same" && c.change !== "no previous result" ? ` <span class="chg ${esc(c.change)}">${esc(c.change)}</span>` : "";
  return `${parts.join(", ")}${change}`;
};

export function renderReportHtml(r) {
  const p = r.panel;
  const engines = p ? p.engines.map((e) => e.engine) : [];
  const css = `
  :root{color-scheme:light;--bg:#fef9f3;--ink:#0b2a2a;--muted:#4a6363;--brand:#186767;--rule:#d9cfc2;--raised:#fff;--accent:#a31d4b}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:72rem;margin:0 auto;padding:2rem 1rem 4rem}h1{font-size:2rem;margin:0 0 .25rem}h2{font-size:1.375rem;margin:2.5rem 0 .75rem}
  .muted{color:var(--muted)}table{width:100%;border-collapse:collapse;background:var(--raised);border:1px solid var(--rule)}
  th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid var(--rule);vertical-align:top;font-size:.9375rem}th{background:var(--bg);font-weight:600}
  .wrap{overflow-x:auto}.banner{background:var(--accent);color:#fff;padding:.75rem 1rem;border-radius:.5rem;font-weight:600;margin:1rem 0}
  .note{border:1px solid var(--rule);background:var(--raised);padding:.75rem 1rem;border-radius:.5rem}ul{padding-left:1.25rem}
  .chg{font-size:.8125rem;font-weight:600;padding:0 .375rem;border:1px solid var(--rule);border-radius:.25rem}.gained{color:var(--brand)}.lost{color:var(--accent)}
  .tot{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem}.tot div{background:var(--raised);border:1px solid var(--rule);border-radius:.5rem;padding:.75rem}
  .tot b{display:block;font-size:1.5rem}@media print{body{background:#fff}}`;

  const out = [];
  out.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Measurement report ${esc(r.month)}</title><style>${css}</style></head><body><main>`);
  out.push(`<h1>Measurement report, ${esc(r.month)}</h1><p class="muted">Generated ${esc(r.generatedAt)}. Counts and facts only: there is no combined visibility score.</p>`);
  if (r.fixture) out.push('<div class="banner" role="note">FIXTURE DATA. Every number below is invented for a dry run. Do not use it for decisions.</div>');

  out.push("<h2>Search and AI answer panel</h2>");
  if (!p) out.push('<p class="note">No query panel exists yet.</p>');
  else {
    out.push(`<p class="muted">Panel version ${esc(p.version)}, ${esc(p.size)} fixed queries.</p>`);
    out.push('<div class="wrap"><table><thead><tr><th>Engine</th><th>Run by</th><th>Method</th><th>Recorded</th><th>We appeared</th><th>We were cited</th><th>Status</th></tr></thead><tbody>');
    for (const e of p.engines) out.push(`<tr><td>${esc(e.engine)}</td><td>${esc(e.runBy)}</td><td>${esc(e.method)}</td><td>${esc(e.recorded)} of ${esc(e.of)}</td><td>${esc(e.appeared)} of ${esc(e.recorded)}</td><td>${esc(e.cited)} of ${esc(e.recorded)}</td><td>${e.completed ? "complete" : "incomplete"}</td></tr>`);
    if (!p.engines.length) out.push('<tr><td colspan="7" class="muted">No runs recorded for this month.</td></tr>');
    out.push("</tbody></table></div>");

    if (engines.length) {
      out.push("<h2>Each query, each engine</h2>");
      out.push(`<div class="wrap"><table><thead><tr><th>#</th><th>Query</th><th>ZIP</th><th>Service</th>${engines.map((e) => `<th>${esc(e)}</th>`).join("")}</tr></thead><tbody>`);
      for (const q of p.queries) out.push(`<tr><td>${esc(q.position)}</td><td>${esc(q.query)}</td><td>${esc(q.zip)}</td><td>${esc(q.serviceLine)}</td>${engines.map((e) => `<td>${cellText(q.engines[e])}</td>`).join("")}</tr>`);
      out.push("</tbody></table></div>");
    }
    out.push("<h2>Sources cited in the answers</h2>");
    if (!p.citedDomains.length) out.push('<p class="muted">No cited sources were recorded.</p>');
    else {
      out.push('<div class="wrap"><table><thead><tr><th>Domain</th><th>Answers citing it</th><th></th></tr></thead><tbody>');
      for (const d of p.citedDomains) out.push(`<tr><td>${esc(d.domain)}</td><td>${esc(d.answers)}</td><td>${d.ours ? "<b>our site</b>" : ""}</td></tr>`);
      out.push("</tbody></table></div>");
    }
  }

  out.push("<h2>Search Console by ZIP</h2>");
  if (!r.search.byZip.length) out.push('<p class="note">No Search Console data for this month.</p>');
  else {
    out.push('<div class="wrap"><table><thead><tr><th>ZIP</th><th>Impressions</th><th>Clicks</th><th>Click rate</th><th>Impressions last month</th><th>Clicks last month</th></tr></thead><tbody>');
    for (const z of r.search.byZip) out.push(`<tr><td>${esc(z.zip)}</td><td>${n(z.impressions)}</td><td>${n(z.clicks)}</td><td>${pct(z.ctr)}</td><td>${n(z.prevImpressions)}</td><td>${n(z.prevClicks)}</td></tr>`);
    out.push("</tbody></table></div>");
  }
  if (r.search.other.length) {
    out.push("<h2>Other imported measurements</h2>");
    out.push('<div class="wrap"><table><thead><tr><th>Source</th><th>Metric</th><th>Where</th><th>Value</th></tr></thead><tbody>');
    for (const o of r.search.other) out.push(`<tr><td>${esc(o.source)}</td><td>${esc(o.metric)}</td><td>${esc(o.dimension)}</td><td>${n(o.value)}</td></tr>`);
    out.push("</tbody></table></div>");
  }

  const t = r.funnel.totals;
  out.push(`<h2>Leads and jobs</h2><p class="muted">${esc(r.funnel.cohortNote)}</p>`);
  out.push(`<div class="tot"><div><b>${n(t.leads)}</b>leads</div><div><b>${n(t.calls)}</b>calls</div><div><b>${n(t.forms)}</b>forms</div><div><b>${n(t.chats)}</b>chats</div><div><b>${n(t.bookings)}</b>booking requests</div><div><b>${n(t.jobs)}</b>booked jobs</div><div><b>${pct(t.leadToJobRate)}</b>lead to job rate</div><div><b>${money(t.spendCents)}</b>ad spend</div><div><b>${money(t.costPerJobCents)}</b>cost per booked job</div></div>`);
  if (r.funnel.byZip.length) {
    out.push('<div class="wrap" style="margin-top:1rem"><table><thead><tr><th>ZIP</th><th>Leads</th><th>Calls</th><th>Forms</th><th>Chats</th><th>Booking requests</th><th>Commercial</th><th>Unrouted</th><th>Jobs</th><th>Lead to job</th></tr></thead><tbody>');
    for (const z of r.funnel.byZip) out.push(`<tr><td>${esc(z.zip)}</td><td>${n(z.leads)}</td><td>${n(z.calls)}</td><td>${n(z.forms)}</td><td>${n(z.chats)}</td><td>${n(z.bookings)}</td><td>${n(z.b2b)}</td><td>${n(z.unrouted)}</td><td>${n(z.jobs)}</td><td>${pct(z.leadToJobRate)}</td></tr>`);
    out.push("</tbody></table></div>");
  }

  out.push("<h2>Read this first</h2><ul>" + r.caveats.map((c) => `<li>${esc(c)}</li>`).join("") + "</ul>");
  out.push("</main></body></html>");
  return out.join("\n");
}
