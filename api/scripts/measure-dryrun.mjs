// Fixture dry run of the whole measurement pipeline on an in-memory Postgres (PGlite). EVERYTHING here is invented.
// Usage: node scripts/measure-dryrun.mjs <outputDir>
import { mkdirSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgliteAdapter, migrate } from "../src/db/adapters.mjs";
import { bigFixtureCatalog } from "../tests/catalog-fixture.mjs";
import { createPanelVersion, getPanel } from "../src/measure/panel.mjs";
import { importPanelResults, importGscPages, importMetrics, recordSpend } from "../src/measure/import.mjs";
import { createLead, transitionLead } from "../src/repo/leads.mjs";
import { buildReport } from "../src/measure/report.mjs";
import { renderReportHtml } from "../src/measure/render.mjs";

const outDir = process.argv[2];
if (!outDir) { console.error("Usage: node scripts/measure-dryrun.mjs <outputDir>"); process.exit(1); }
mkdirSync(outDir, { recursive: true });

const pg = new PGlite();
const db = pgliteAdapter(pg);
await migrate(db);
const now = new Date("2026-12-10T15:00:00Z");
await db.query("INSERT INTO routing_rules (zip, service_line, branch_id) VALUES ('00001', '*', 'branch-a'), ('00002', '*', 'branch-a'), ('00003', '*', 'branch-b')");

const v = await createPanelVersion(db, { label: "FIXTURE 2026-11 v1", catalog: bigFixtureCatalog(), now });
const panel = await getPanel(db, v.id);
const HEAD = "run_month,engine,query_id,appeared,position,our_cited,cited_urls,evidence_ref";
const urlsFor = (i) => [["https://www.rival-hvac.example/a", "https://directory.example/x"], ["https://rival-hvac.example/b"], [], ["https://fixture-company.example/service-area/city0-00001/", "https://directory.example/y"]][i % 4].join("; ");
const csv = (month, engine, hit, n = 40) => [HEAD, ...panel.queries.slice(0, n).map((q, i) =>
  [month, engine, q.id, hit(i) ? "yes" : "no", hit(i) ? 1 + (i % 6) : "", hit(i) && i % 3 === 0 ? "yes" : "no", urlsFor(i), `fixture-${engine}-${q.id}.png`].join(","))].join("\n");
await importPanelResults(db, csv("2026-11", "google_search", (i) => i % 4 === 0), { versionId: v.id, runBy: "Fixture Person", now });
await importPanelResults(db, csv("2026-12", "google_search", (i) => i % 3 === 0), { versionId: v.id, runBy: "Fixture Person", now });
await importPanelResults(db, csv("2026-12", "google_ai_overview", (i) => i % 5 === 0), { versionId: v.id, runBy: "Fixture Person", now });
await importPanelResults(db, csv("2026-12", "perplexity", (i) => i % 4 === 1, 22), { versionId: v.id, runBy: "Fixture Person", now }); // left incomplete on purpose

const gsc = (k) => ["Top pages,Clicks,Impressions,CTR,Position",
  ...["city0-00001", "city1-00002", "city2-00003"].map((s, i) => `https://fixture-company.example/service-area/${s}/,${(6 + i * 3) * k},${(400 + i * 150) * k},1%,9`),
  `https://fixture-company.example/services/repair/,${20 * k},${1500 * k},1%,7`].join("\n");
await importGscPages(db, gsc(1), { month: "2026-11", now });
await importGscPages(db, gsc(2), { month: "2026-12", now });
await importMetrics(db, "month,metric,dimension_type,dimension_value,value\n2026-12,calls,branch,branch-a,31\n2026-12,direction_requests,branch,branch-a,12\n2026-12,website_clicks,branch,branch-a,58\n", { source: "gbp", now });
await recordSpend(db, { month: "2026-12", channel: "google_ads", amount: "1200", now });
await recordSpend(db, { month: "2026-12", channel: "mailers", amount: "350.50", now });

const user = { type: "user", id: "fixture-dispatcher" };
const channels = ["form", "call", "form", "chat", "booking", "form", "call", "form"];
const zips = ["00001", "00001", "00002", "00003", "00001", "00002", "00009", "00003"];
for (let i = 0; i < 16; i++) {
  const when = new Date(Date.UTC(2026, 11, 1 + (i % 9), 14, i));
  const r = await createLead(db, {
    type: i === 5 ? "B2B" : "B2C", channel: channels[i % 8], name: `Fixture Person ${i}`, phone: `(415) 555-${String(300 + i).padStart(4, "0")}`,
    email: `fixture${i}@example.org`, zip: zips[i % 8], serviceLine: ["repair", "install", "tuneup"][i % 3], consents: [], details: {}, ...(i === 5 ? { b2b: { company: "Fixture Property LLC", kind: "commercial" } } : {}),
  }, { now: when });
  if (r.deduped) continue;
  const step = (to, m, extra = {}) => transitionLead(db, r.id, to, user, { now: new Date(when.getTime() + m * 3600_000), ...extra });
  if (i % 5 === 0) { await step(i === 5 ? "site_visit" : "contacted", 1); await step(i === 5 ? "quote" : "booked", 2); if (i % 10 === 0) await step(i === 5 ? "won" : "won", 5).catch(() => {}); }
  else if (i % 4 === 1) { await step("contacted", 1); await step("lost", 2, { reason: "no answer" }); }
  else if (i % 3 === 0) { await step("contacted", 1); await step("booked", 3); }
}

const report = await buildReport(db, { month: "2026-12", ourDomain: "fixture-company.example", fixture: true, now });
writeFileSync(`${outDir}/measure-fixture-dryrun.html`, renderReportHtml(report));
writeFileSync(`${outDir}/measure-fixture-dryrun.json`, JSON.stringify(report, null, 2));
console.log(`engines: ${report.panel.engines.map((e) => `${e.engine} ${e.recorded}/${e.of}`).join(", ")}`);
console.log(`leads ${report.funnel.totals.leads}, jobs ${report.funnel.totals.jobs}, cost per job cents ${report.funnel.totals.costPerJobCents}`);
console.log(`caveats: ${report.caveats.length}; wrote ${outDir}/measure-fixture-dryrun.{html,json}`);
await pg.close();
