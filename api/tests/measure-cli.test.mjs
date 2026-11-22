import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDb } from "./helpers.mjs";
import { bigFixtureCatalog } from "./catalog-fixture.mjs";
import { run } from "../src/measure/cli.mjs";
import { parseCsv, toCsv } from "../src/measure/csv.mjs";
import { ImportError } from "../src/measure/import.mjs";

const capture = () => { const o = []; return { io: { out: (s) => o.push(s), err: (s) => o.push(s) }, text: () => o.join("") }; };

test("monthly workflow through the CLI: panel, template, fill, import, spend, report", async () => {
  const { db, close } = await newDb();
  const dir = mkdtempSync(join(tmpdir(), "measure-cli-"));
  const catalogPath = join(dir, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify(bigFixtureCatalog()));

  let c = capture();
  const v = await run(["panel-create", "--label", "cli v1", "--catalog", catalogPath], db, c.io);
  assert.equal(v.size, 40);
  assert.match(c.text(), /40 queries \(frozen\)/);

  c = capture();
  await run(["results-template", "--version", String(v.id), "--month", "2026-12", "--engine", "perplexity"], db, c.io);
  const tpl = parseCsv(c.text());
  assert.equal(tpl.rows.length, 40);
  assert.equal(tpl.rows[0].engine, "perplexity");

  const filled = tpl.rows.map((r, i) => ({ ...r, appeared: i % 4 === 0 ? "yes" : "no", position: i % 4 === 0 ? "2" : "", our_cited: i % 4 === 0 ? "yes" : "no", cited_urls: "https://example.org/x", evidence_ref: `shot-${r.query_id}.png` }));
  const file = join(dir, "filled.csv");
  writeFileSync(file, toCsv(Object.keys(tpl.rows[0]).filter((k) => k !== "line"), filled));
  c = capture();
  await run(["import-results", file, "--version", String(v.id), "--run-by", "Tester"], db, c.io);
  assert.match(c.text(), /40 of 40 recorded \(run complete, now immutable\)/);

  await run(["spend", "--month", "2026-12", "--channel", "google_ads", "--amount", "1000"], db, capture().io);
  const out = join(dir, "r.html"), json = join(dir, "r.json");
  await run(["report", "--month", "2026-12", "--out", out, "--json", json, "--fixture"], db, capture().io);
  const rep = JSON.parse(readFileSync(json, "utf8"));
  assert.deepEqual(rep.panel.engines.map((e) => [e.engine, e.recorded, e.appeared]), [["perplexity", 40, 10]]);
  assert.equal(rep.fixture, true);
  assert.equal(rep.funnel.totals.spendCents, 100000);
  assert.match(readFileSync(out, "utf8"), /FIXTURE DATA/);
  await close();
});

test("CLI refuses bad input with a clear message", async () => {
  const { db, close } = await newDb();
  await assert.rejects(run(["frobnicate"], db, capture().io), /Commands:/);
  await assert.rejects(run(["results-template", "--version", "1", "--month", "2026-12", "--engine", "askjeeves"], db, capture().io), /Unknown engine/);
  await assert.rejects(run(["spend", "--month", "2026-12", "--channel", "x", "--amount", "abc"], db, capture().io), /Invalid amount/);
  await assert.rejects(run(["report"], db, capture().io), /Missing --month/);
  await assert.rejects(run(["panel-create", "--label", "x", "--catalog", join(tmpdir(), "does-not-exist.json")], db, capture().io), /no ZIP and service/);
  const dir = mkdtempSync(join(tmpdir(), "measure-cli-"));
  writeFileSync(join(dir, "bad.csv"), "a,b\n1,2\n");
  await assert.rejects(run(["import-gsc", join(dir, "bad.csv"), "--month", "2026-12"], db, capture().io), (e) => e instanceof ImportError);
  await close();
});
