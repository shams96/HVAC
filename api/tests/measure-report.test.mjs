import { test } from "node:test";
import assert from "node:assert/strict";
import { newDb, T0, minutes, seedRoutes, b2c } from "./helpers.mjs";
import { bigFixtureCatalog } from "./catalog-fixture.mjs";
import { createPanelVersion, getPanel } from "../src/measure/panel.mjs";
import { importPanelResults, importGscPages, importMetrics, recordSpend } from "../src/measure/import.mjs";
import { buildReport } from "../src/measure/report.mjs";
import { renderReportHtml } from "../src/measure/render.mjs";
import { createLead, transitionLead } from "../src/repo/leads.mjs";

const MARCH = "2026-03"; // T0 is 2026-03-02
const FEB = "2026-02";
const HEAD = "run_month,engine,query_id,appeared,position,our_cited,cited_urls,evidence_ref";

async function seeded() {
  const { db, close } = await newDb();
  await seedRoutes(db);
  const v = await createPanelVersion(db, { label: "v1", catalog: bigFixtureCatalog(), now: T0 });
  const p = await getPanel(db, v.id);
  const csv = (month, hit, urlFor = () => "") =>
    [HEAD, ...p.queries.map((q, i) => [month, "google_search", q.id, hit(i) ? "yes" : "no", hit(i) ? 1 + (i % 5) : "", hit(i) && i % 4 === 0 ? "yes" : "no", urlFor(i), `shot-${q.id}.png`].join(","))].join("\n");
  await importPanelResults(db, csv(FEB, (i) => i % 3 === 0), { versionId: v.id, runBy: "alex", now: T0 });
  await importPanelResults(db, csv(MARCH, (i) => i % 2 === 0, (i) => (i % 5 === 0 ? "https://our-site.example/a; https://rival.example/x" : i % 5 === 1 ? "https://rival.example/y" : "")), { versionId: v.id, runBy: "alex", now: T0 });
  return { db, close, v, p };
}

function keysDeep(o, acc = []) {
  if (Array.isArray(o)) o.forEach((x) => keysDeep(x, acc));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { acc.push(k); keysDeep(v, acc); }
  return acc;
}

test("panel section: counts per engine, per-query change vs last month, cited domains, and no combined score", async () => {
  const { db, close } = await seeded();
  const r = await buildReport(db, { month: MARCH, ourDomain: "www.our-site.example", now: T0 });
  const e = r.panel.engines[0];
  assert.deepEqual([e.engine, e.recorded, e.of, e.completed], ["google_search", 40, 40, true]);
  const idx = [...Array(40).keys()];
  assert.equal(e.appeared, idx.filter((i) => i % 2 === 0).length);
  assert.equal(e.cited, idx.filter((i) => i % 2 === 0 && i % 4 === 0).length);

  const gained = idx.filter((i) => i % 2 === 0 && i % 3 !== 0).length;
  const lost = idx.filter((i) => i % 2 !== 0 && i % 3 === 0).length;
  const tally = (c) => r.panel.queries.filter((q) => q.engines.google_search.change === c).length;
  assert.equal(tally("gained"), gained);
  assert.equal(tally("lost"), lost);

  const d = Object.fromEntries(r.panel.citedDomains.map((x) => [x.domain, x]));
  assert.equal(d["our-site.example"].ours, true, "www and case are normalized when matching our domain");
  assert.equal(d["rival.example"].ours, false);
  assert.equal(d["rival.example"].answers, idx.filter((i) => i % 5 === 0 || i % 5 === 1).length);

  const bad = keysDeep(r).filter((k) => /score|visib|overall|grade/i.test(k));
  assert.deepEqual(bad, [], "no combined visibility score anywhere in the report");
  await close();
});

test("first month has no previous results and says so", async () => {
  const { db, close } = await seeded();
  const r = await buildReport(db, { month: FEB, now: T0 });
  assert.ok(r.panel.queries.every((q) => q.engines.google_search.change === "no previous result"));
  assert.ok(r.caveats.some((c) => /no previous month/i.test(c)));
  await close();
});

test("funnel: cohort by lead creation month, jobs = reached booked or won, spend and cost per job", async () => {
  const { db, close } = await seeded();
  const user = { type: "user", id: "dispatcher" };
  const mk = (o, when = T0) => createLead(db, b2c(o), { now: when });
  const A = await mk({ phone: "(415) 555-0201", email: "a@example.org" });
  const B = await mk({ phone: "(415) 555-0202", email: "b@example.org", channel: "booking" });
  const C = await mk({ phone: "(415) 555-0203", email: "c@example.org", channel: "chat" });
  await mk({ phone: "(415) 555-0204", email: "d@example.org", zip: "00009" }); // unrouted
  await mk({ phone: "(415) 555-0205", email: "e@example.org", channel: "call" });
  await transitionLead(db, A.id, "contacted", user, { now: minutes(5) });
  await transitionLead(db, A.id, "booked", user, { now: minutes(6) });
  await transitionLead(db, B.id, "contacted", user, { now: minutes(5) });
  await transitionLead(db, B.id, "booked", user, { now: minutes(6) });
  await transitionLead(db, B.id, "won", user, { now: minutes(7) });
  await transitionLead(db, C.id, "contacted", user, { now: minutes(5) });
  await transitionLead(db, C.id, "lost", user, { reason: "no answer", now: minutes(6) });
  // created in February, booked in March: counts toward February's cohort only
  const old = await mk({ phone: "(415) 555-0206", email: "f@example.org" }, new Date("2026-02-15T12:00:00Z"));
  await transitionLead(db, old.id, "contacted", user, { now: new Date("2026-03-03T12:00:00Z") });
  await transitionLead(db, old.id, "booked", user, { now: new Date("2026-03-03T13:00:00Z") });
  await recordSpend(db, { month: MARCH, channel: "google_ads", amount: "800", now: T0 });
  await recordSpend(db, { month: MARCH, channel: "mailers", amount: "200.50", now: T0 });

  const m = await buildReport(db, { month: MARCH, now: T0 });
  const t = m.funnel.totals;
  assert.deepEqual([t.leads, t.calls, t.forms, t.chats, t.bookings, t.unrouted, t.jobs], [5, 1, 2, 1, 1, 1, 2]);
  assert.equal(t.leadToJobRate, 2 / 5);
  assert.equal(t.spendCents, 100050);
  assert.equal(t.costPerJobCents, 50025);
  const z1 = m.funnel.byZip.find((z) => z.zip === "00001");
  assert.deepEqual([z1.leads, z1.jobs], [4, 2]);
  assert.equal(m.funnel.byZip.find((z) => z.zip === "00009").unrouted, 1);

  const f = await buildReport(db, { month: FEB, now: T0 });
  assert.deepEqual([f.funnel.totals.leads, f.funnel.totals.jobs], [1, 1], "the February lead booked in March counts for February");
  assert.equal(f.funnel.totals.costPerJobCents, null, "no spend entered for February");
  assert.ok(f.caveats.some((c) => /No ad spend/.test(c)));
  await close();
});

test("no data is null, never zero: empty month, spend without jobs", async () => {
  const { db, close } = await seeded();
  const e = await buildReport(db, { month: "2026-07", now: T0 });
  assert.equal(e.funnel.totals.leads, 0);
  assert.equal(e.funnel.totals.leadToJobRate, null);
  assert.equal(e.funnel.totals.costPerJobCents, null);
  assert.ok(e.caveats.some((c) => /No leads/.test(c)));
  await recordSpend(db, { month: "2026-07", channel: "google_ads", amount: "500", now: T0 });
  await createLead(db, b2c({ phone: "(415) 555-0210", email: "g@example.org" }), { now: new Date("2026-07-10T12:00:00Z") });
  const s = await buildReport(db, { month: "2026-07", now: T0 });
  assert.equal(s.funnel.totals.spendCents, 50000);
  assert.equal(s.funnel.totals.costPerJobCents, null);
  assert.ok(s.caveats.some((c) => /not available \(not zero\)/.test(c)));
  assert.ok(s.caveats.some((c) => /Only 1 leads/.test(c)), "small counts are called out");
  const html = renderReportHtml(s);
  assert.match(html, /no data/);
  assert.equal(html.includes("$0.00"), false);
  await close();
});

test("search section: Search Console by ZIP with last month alongside, other sources listed", async () => {
  const { db, close } = await seeded();
  const gsc = (a, b) => `Top pages,Clicks,Impressions\nhttps://s.example/service-area/city0-00001/,${a},${b}\n`;
  await importGscPages(db, gsc(10, 1000), { month: FEB, now: T0 });
  await importGscPages(db, gsc(30, 1500), { month: MARCH, now: T0 });
  await importMetrics(db, "month,metric,dimension_type,dimension_value,value\n2026-03,calls,branch,main,42\n", { source: "gbp", now: T0 });
  const r = await buildReport(db, { month: MARCH, now: T0 });
  assert.deepEqual(r.search.byZip, [{ zip: "00001", impressions: 1500, clicks: 30, prevImpressions: 1000, prevClicks: 10, ctr: 0.02 }]);
  assert.deepEqual(r.search.other, [{ source: "gbp", metric: "calls", dimension: "branch main", value: 42 }]);
  assert.equal(r.caveats.some((c) => /Business Profile/.test(c)), false, "GBP data present, so no GBP warning");
  await close();
});

test("html: escapes everything, no scripts or external requests, fixture banner only when asked", async () => {
  const { db, close } = await seeded();
  await importMetrics(db, 'month,metric,dimension_type,dimension_value,value\n2026-03,walk_ins,page,"<img src=x onerror=alert(1)>",3\n', { source: "manual", now: T0 });
  const r = await buildReport(db, { month: MARCH, now: T0 });
  const html = renderReportHtml(r);
  assert.equal(html.includes("<img src=x"), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(/<script/i.test(html), false);
  assert.equal(/<[^>]*\b(src|href)\s*=|@import|url\(/i.test(html), false, "no external requests (escaped text such as src=x inside a cell is fine)");
  assert.equal(html.includes("FIXTURE DATA"), false);
  const fx = renderReportHtml({ ...r, fixture: true });
  assert.match(fx, /FIXTURE DATA/);
  assert.match(html, /There is no combined visibility score|no combined visibility score/);
  await close();
});

test("empty database still produces a report that explains what is missing", async () => {
  const { db, close } = await newDb();
  const r = await buildReport(db, { month: MARCH, now: T0 });
  assert.equal(r.panel, null);
  assert.ok(r.caveats.some((c) => /No query panel/.test(c)));
  assert.doesNotThrow(() => renderReportHtml(r));
  await close();
});
