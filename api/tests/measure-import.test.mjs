import { test } from "node:test";
import assert from "node:assert/strict";
import { newDb, T0 } from "./helpers.mjs";
import { bigFixtureCatalog } from "./catalog-fixture.mjs";
import { createPanelVersion, getPanel } from "../src/measure/panel.mjs";
import { importPanelResults, importGscPages, importMetrics, recordSpend, dollarsToCents, parseMonth, ImportError } from "../src/measure/import.mjs";

async function panel() {
  const { db, close } = await newDb();
  const v = await createPanelVersion(db, { label: "v1", catalog: bigFixtureCatalog(), now: T0 });
  const p = await getPanel(db, v.id);
  return { db, close, v, p };
}
const HEAD = "run_month,engine,query_id,appeared,position,our_cited,cited_urls,evidence_ref";
const row = (month, engine, id, appeared, position, cited, urls, ev) => [month, engine, id, appeared, position, cited, urls, ev].join(",");
const resultsCsv = (p, { engine = "google_search", month = "2026-12", n = p.queries.length, every = 3, urls = "" } = {}) =>
  [HEAD, ...p.queries.slice(0, n).map((q, i) => {
    const hit = i % every === 0;
    return row(month, engine, q.id, hit ? "yes" : "no", hit ? (i % 7) + 1 : "", hit ? "yes" : "no", urls, `shot-${q.id}.png`);
  })].join("\n");
const rejects = (promise, re) => assert.rejects(promise, (e) => e instanceof ImportError && re.test(e.message), String(re));

test("months and money", () => {
  assert.equal(parseMonth("2026-12"), "2026-12-01");
  assert.equal(parseMonth("2026-12-01"), "2026-12-01");
  for (const bad of ["2026-13", "2026-12-15", "Dec 2026", "", null]) assert.throws(() => parseMonth(bad), /Invalid month/, String(bad));
  assert.equal(dollarsToCents("500"), 50000);
  assert.equal(dollarsToCents("$1,250.5"), 125050);
  assert.equal(dollarsToCents("0.07"), 7);
  for (const bad of ["-5", "1e3", "12.345", "abc", ""]) assert.throws(() => dollarsToCents(bad), /Invalid amount/, bad);
});

test("results: a full run is recorded, domains extracted, run completes and becomes immutable", async () => {
  const { db, close, v, p } = await panel();
  const urls = "https://www.Competitor.example/page; https://our-site.example/service-area/city0-00001/";
  const out = await importPanelResults(db, resultsCsv(p, { urls }), { versionId: v.id, runBy: "alex", now: T0 });
  assert.deepEqual(out, [{ month: "2026-12", engine: "google_search", inserted: 40, recorded: 40, of: 40, completed: true }]);
  const r = (await db.query("SELECT cited_domains FROM panel_results ORDER BY id LIMIT 1")).rows[0];
  assert.deepEqual(r.cited_domains, ["competitor.example", "our-site.example"]);
  await assert.rejects(db.query("UPDATE panel_results SET our_cited = true"), /immutable/);
  await assert.rejects(db.query("DELETE FROM panel_results"), /immutable/);
  await assert.rejects(db.query("UPDATE panel_runs SET run_by = 'x'"), /immutable/);
  await assert.rejects(db.query("DELETE FROM panel_runs"), /cannot be deleted/);
  await rejects(importPanelResults(db, resultsCsv(p), { versionId: v.id, runBy: "alex" }), /already complete/);
  await close();
});

test("results: a partial run stays open and can be finished later; no double entries", async () => {
  const { db, close, v, p } = await panel();
  const a = await importPanelResults(db, resultsCsv(p, { n: 25 }), { versionId: v.id, runBy: "alex", now: T0 });
  assert.equal(a[0].completed, false);
  assert.equal(a[0].recorded, 25);
  await rejects(importPanelResults(db, resultsCsv(p, { n: 5 }), { versionId: v.id, runBy: "alex" }), /already recorded/);
  const rest = [HEAD, ...p.queries.slice(25).map((q) => row("2026-12", "google_search", q.id, "no", "", "no", "", `shot-${q.id}.png`))].join("\n");
  const b = await importPanelResults(db, rest, { versionId: v.id, runBy: "alex", now: T0 });
  assert.equal(b[0].completed, true);
  assert.equal(b[0].recorded, 40);
  await close();
});

test("results: bad files are rejected whole, with line numbers", async () => {
  const { db, close, v, p } = await panel();
  const id = (k) => p.queries[k].id;
  const bad = [
    HEAD,
    row("2026-12", "askjeeves", id(0), "yes", 1, "yes", "", "s.png"),
    row("2026-12", "google_search", 999999, "yes", 1, "yes", "", "s.png"),
    row("2026-12", "google_search", id(0), "maybe", 1, "yes", "", "s.png"),
    row("2026-12", "google_search", id(1), "no", 3, "no", "", "s.png"),
    row("2026-12", "google_search", id(2), "yes", 500, "no", "", "s.png"),
    row("2026-12", "google_search", id(3), "yes", 1, "yes", "javascript:alert(1)", "s.png"),
    row("2026-12", "google_search", id(4), "yes", 1, "yes", "", ""),
    row("2026-13", "google_search", id(5), "yes", 1, "yes", "", "s.png"),
    row("2026-12", "google_search", id(6), "yes", 1, "yes", "", "s.png"),
    row("2026-12", "google_search", id(6), "yes", 1, "yes", "", "s.png"),
  ].join("\n");
  try {
    await importPanelResults(db, bad, { versionId: v.id, runBy: "alex" });
    assert.fail("should reject");
  } catch (e) {
    assert.ok(e instanceof ImportError, e.message);
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 11]) assert.match(e.message, new RegExp(`Line ${n}:`), `line ${n}`);
  }
  assert.equal((await db.query("SELECT count(*)::int AS n FROM panel_results")).rows[0].n, 0, "nothing saved");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM panel_runs")).rows[0].n, 0);
  await rejects(importPanelResults(db, "a,b\n1,2\n", { versionId: v.id, runBy: "alex" }), /Missing column/);
  await rejects(importPanelResults(db, resultsCsv(p), { versionId: v.id, runBy: "" }), /run_by/);
  await rejects(importPanelResults(db, resultsCsv(p), { versionId: v.id, runBy: "a", method: "scrape" }), /method/);
  await close();
});

test("results: a query from another panel version cannot be written, even by direct SQL", async () => {
  const { db, close, v, p } = await panel();
  const v2 = await createPanelVersion(db, { label: "v2", catalog: bigFixtureCatalog(), now: T0 });
  const p2 = await getPanel(db, v2.id);
  await importPanelResults(db, resultsCsv(p, { n: 1 }), { versionId: v.id, runBy: "a", now: T0 });
  const run = (await db.query("SELECT id FROM panel_runs")).rows[0].id;
  await assert.rejects(db.query("INSERT INTO panel_results (run_id, query_id, our_appeared) VALUES ($1, $2, false)", [run, p2.queries[0].id]), /does not belong/);
  await close();
});

test("gsc: ZIP pages map to ZIPs, other pages stay page level, rows sum, re-import is idempotent", async () => {
  const { db, close } = await panel();
  const csv = [
    "Top pages,Clicks,Impressions,CTR,Position",
    'https://site.example/service-area/sampleville-00001/,12,"1,200",1%,8.2',
    "https://site.example/service-area/sampleville-00001/?utm=x,3,300,1%,9.0",
    "https://site.example/service-area/exampleton-00002,5,400,1.2%,7",
    "https://site.example/services/repair/,9,900,1%,6",
    "https://site.example/,20,5000,0.4%,12",
  ].join("\n");
  const r = await importGscPages(db, csv, { month: "2026-12", now: T0 });
  assert.deepEqual(r, { month: "2026-12", zipRows: 2, pageRows: 2 });
  const get = async (m, dim, val) => Number((await db.query("SELECT value FROM metrics WHERE source='gsc' AND metric=$1 AND dim_type=$2 AND dim_value=$3", [m, dim, val])).rows[0]?.value);
  assert.equal(await get("clicks", "zip", "00001"), 15);
  assert.equal(await get("impressions", "zip", "00001"), 1500);
  assert.equal(await get("clicks", "zip", "00002"), 5);
  assert.equal(await get("impressions", "page", "/services/repair/"), 900);
  await importGscPages(db, csv, { month: "2026-12", now: T0 });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM metrics")).rows[0].n, 8, "no duplicates after re-import");
  await rejects(importGscPages(db, "Top pages,Clicks,Impressions\n/x/,10,5\n", { month: "2026-12" }), /exceed impressions/);
  await rejects(importGscPages(db, "Top pages,Clicks,Impressions\n/x/,a,5\n", { month: "2026-12" }), /whole numbers/);
  await rejects(importGscPages(db, "Foo,Clicks,Impressions\n/x/,1,5\n", { month: "2026-12" }), /page column/);
  await close();
});

test("metrics: per-source allowlists, dimension rules, idempotent upsert", async () => {
  const { db, close } = await panel();
  const H = "month,metric,dimension_type,dimension_value,value\n";
  const ok = `${H}2026-12,calls,branch,main,42\n2026-12,direction_requests,branch,main,7\n`;
  assert.deepEqual(await importMetrics(db, ok, { source: "gbp", now: T0 }), { rows: 2 });
  await importMetrics(db, `${H}2026-12,calls,branch,main,50\n`, { source: "gbp", now: T0 });
  assert.equal(Number((await db.query("SELECT value FROM metrics WHERE metric='calls'")).rows[0].value), 50);
  await rejects(importMetrics(db, `${H}2026-12,clicks,branch,main,1\n`, { source: "gbp" }), /not valid for source gbp/);
  await rejects(importMetrics(db, `${H}2026-12,calls,zip,12,1\n`, { source: "gbp" }), /5 digit/);
  await rejects(importMetrics(db, `${H}2026-12,calls,branch,main,-3\n`, { source: "gbp" }), /0 or more/);
  await rejects(importMetrics(db, ok, { source: "tiktok" }), /Unknown source/);
  assert.deepEqual(await importMetrics(db, `${H}2026-12,walk_ins,site,,4\n`, { source: "manual" }), { rows: 1 });
  await close();
});

test("spend: stored as cents, one row per month and channel", async () => {
  const { db, close } = await panel();
  await recordSpend(db, { month: "2026-12", channel: "google_ads", amount: "1250.50", now: T0 });
  await recordSpend(db, { month: "2026-12", channel: "google_ads", amount: "1300", now: T0 });
  const rows = (await db.query("SELECT channel, amount_cents FROM ad_spend")).rows;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount_cents), 130000);
  await assert.rejects(recordSpend(db, { month: "2026-12", channel: "x", amount: "-1" }), /Invalid amount/);
  await close();
});
