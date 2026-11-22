// Monthly measurement commands. Usage: node src/measure/cli.mjs <command> [options]   (needs DATABASE_URL)
//   panel-create     --label "2026-12 v1" [--catalog config/catalog.json] [--size 40]
//   results-template --version 1 --month 2026-12 --engine google_search      (CSV to stdout)
//   import-results   FILE --version 1 --run-by "Name" [--method manual|official_api]
//   import-gsc       FILE --month 2026-12                                      (Search Console "Pages" export)
//   import-metrics   FILE --source gbp|analytics|call_tracking|manual
//   spend            --month 2026-12 --channel google_ads --amount 1250.50 [--note "..."]
//   report           --month 2026-12 [--version 1] [--site-url https://example.com] --out report.html [--json report.json]
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { pgAdapter, migrate } from "../db/adapters.mjs";
import { loadCatalog } from "../catalog.mjs";
import { createPanelVersion, getPanel, ENGINES } from "./panel.mjs";
import { importPanelResults, importGscPages, importMetrics, recordSpend, parseMonth, ImportError } from "./import.mjs";
import { buildReport } from "./report.mjs";
import { renderReportHtml } from "./render.mjs";
import { toCsv } from "./csv.mjs";

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { opt[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i]; }
    else pos.push(argv[i]);
  }
  return { pos, opt };
}
const need = (opt, k) => { if (!opt[k] || opt[k] === true) throw new Error(`Missing --${k}`); return opt[k]; };

export async function run(argv, db, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const [cmd, ...rest] = argv;
  const { pos, opt } = parseArgs(rest);
  const file = () => { if (!pos[0]) throw new Error("Missing the CSV file path"); return readFileSync(pos[0], "utf8"); };
  switch (cmd) {
    case "panel-create": {
      const catalog = loadCatalog(opt.catalog && opt.catalog !== true ? opt.catalog : undefined);
      const v = await createPanelVersion(db, { label: need(opt, "label"), catalog, size: opt.size ? Number(opt.size) : 40 });
      io.out(`panel version ${v.id} created with ${v.size} queries (frozen)\n`);
      return v;
    }
    case "results-template": {
      const engine = need(opt, "engine");
      if (!ENGINES.includes(engine)) throw new Error(`Unknown engine. Allowed: ${ENGINES.join(", ")}`);
      const month = parseMonth(need(opt, "month")).slice(0, 7);
      const panel = await getPanel(db, Number(need(opt, "version")));
      const cols = ["run_month", "engine", "query_id", "query_text", "appeared", "position", "our_cited", "cited_urls", "evidence_ref"];
      io.out(toCsv(cols, panel.queries.map((q) => ({ run_month: month, engine, query_id: q.id, query_text: q.text }))));
      return null;
    }
    case "import-results": {
      const s = await importPanelResults(db, file(), { versionId: Number(need(opt, "version")), runBy: need(opt, "run-by"), method: opt.method ?? "manual" });
      for (const x of s) io.out(`${x.engine} ${x.month}: ${x.recorded} of ${x.of} recorded${x.completed ? " (run complete, now immutable)" : " (run still open)"}\n`);
      return s;
    }
    case "import-gsc": { const r = await importGscPages(db, file(), { month: need(opt, "month"), batch: pos[0] }); io.out(`gsc ${r.month}: ${r.zipRows} ZIP pages, ${r.pageRows} other pages\n`); return r; }
    case "import-metrics": { const r = await importMetrics(db, file(), { source: need(opt, "source"), batch: pos[0] }); io.out(`${r.rows} metric rows saved\n`); return r; }
    case "spend": { const r = await recordSpend(db, { month: need(opt, "month"), channel: need(opt, "channel"), amount: need(opt, "amount"), note: opt.note === true ? null : opt.note }); io.out(`spend saved: ${r.channel} ${r.month} ${(r.cents / 100).toFixed(2)}\n`); return r; }
    case "report": {
      const site = opt["site-url"] && opt["site-url"] !== true ? new URL(opt["site-url"]).hostname : null;
      const rep = await buildReport(db, { month: need(opt, "month"), versionId: opt.version ? Number(opt.version) : null, ourDomain: site, fixture: opt.fixture === true });
      if (opt.out) { writeFileSync(opt.out, renderReportHtml(rep)); io.out(`report written to ${opt.out}\n`); }
      if (opt.json) { writeFileSync(opt.json, JSON.stringify(rep, null, 2)); io.out(`json written to ${opt.json}\n`); }
      if (!opt.out && !opt.json) io.out(JSON.stringify(rep, null, 2) + "\n");
      return rep;
    }
    default:
      throw new Error("Commands: panel-create, results-template, import-results, import-gsc, import-metrics, spend, report (see the header of this file)");
  }
}

// Entry point (skipped when imported by tests).
if (import.meta.url === new URL(process.argv[1] ?? "", "file:///").href || process.argv[1]?.endsWith("cli.mjs")) {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }
  pg.types.setTypeParser(20, (v) => Number(v));
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const db = pgAdapter(pool);
    await migrate(db);
    await run(process.argv.slice(2), db);
  } catch (e) {
    console.error(e instanceof ImportError ? e.message : `Error: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
