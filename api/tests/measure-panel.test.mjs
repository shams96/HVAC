import { test } from "node:test";
import assert from "node:assert/strict";
import { newDb, T0 } from "./helpers.mjs";
import { parseCsv, toCsv, CsvError } from "../src/measure/csv.mjs";
import { generatePanel, createPanelVersion, getPanel, catalogHash } from "../src/measure/panel.mjs";
import { bigFixtureCatalog as bigCatalog } from "./catalog-fixture.mjs";

test("csv: quotes, escaped quotes, CRLF, BOM, embedded newline", () => {
  const { header, rows } = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"line1\nline2",z\r\n');
  assert.deepEqual(header, ["a", "b", "c"]);
  assert.equal(rows[0].b, "x, y");
  assert.equal(rows[0].c, 'say "hi"');
  assert.equal(rows[1].b, "line1\nline2");
});
test("csv: errors name the line", () => {
  assert.throws(() => parseCsv("a,b\n1,2,3\n"), /Line 2: expected 2 columns/);
  assert.throws(() => parseCsv('a\n"open\n'), CsvError);
  assert.throws(() => parseCsv("a,a\n1,2\n"), /duplicate/);
  assert.throws(() => parseCsv(""), /empty/);
  assert.throws(() => parseCsv("a\n1\n2\n", { maxRows: 1 }), /Too many/);
});
test("csv export: formula injection is neutralized, numbers are not", () => {
  const out = toCsv(["q", "n"], [{ q: "=HYPERLINK(\"http://evil\")", n: "-5" }, { q: "+cmd", n: 3 }, { q: "plain, text", n: "" }]);
  assert.match(out, /"'=HYPERLINK/);
  assert.match(out, /'\+cmd/);
  assert.match(out, /-5/);
  assert.equal(out.includes(",'-5"), false);
  assert.match(out, /"plain, text"/);
});

test("panel: exactly 40, unique, deterministic, balanced across ZIPs and services", () => {
  const a = generatePanel(bigCatalog());
  const b = generatePanel(bigCatalog());
  assert.equal(a.queries.length, 40);
  assert.deepEqual(a.queries, b.queries, "deterministic");
  assert.equal(new Set(a.queries.map((q) => q.text.toLowerCase())).size, 40);
  const perZip = {};
  for (const q of a.queries) perZip[q.zip] = (perZip[q.zip] ?? 0) + 1;
  assert.ok(Math.max(...Object.values(perZip)) - Math.min(...Object.values(perZip)) <= 4, JSON.stringify(perZip));
  assert.equal(new Set(a.queries.map((q) => q.serviceLine)).size, 3);
  assert.ok(new Set(a.queries.map((q) => q.intent)).size >= 4, "several intents");
  assert.ok(a.queries.some((q) => q.text.includes("hvac tune up")), "searchTerm overrides the display name");
  assert.deepEqual(a.queries.map((q) => q.position), Array.from({ length: 40 }, (_, i) => i + 1));
});
test("panel: refuses when the catalog cannot support 40 distinct queries", () => {
  assert.throws(() => generatePanel({ ...bigCatalog(), areas: bigCatalog().areas.slice(0, 1) }), /only supports/);
  assert.throws(() => generatePanel({ ...bigCatalog(), areas: [] }), /no ZIP and service/);
});
test("catalog hash changes when the catalog changes, not when order does", () => {
  const c = bigCatalog();
  assert.equal(catalogHash(c), catalogHash({ ...c, areas: [...c.areas].reverse() }));
  assert.notEqual(catalogHash(c), catalogHash({ ...c, areas: c.areas.slice(1) }));
});

test("panel version is frozen in the database", async () => {
  const { db, close } = await newDb();
  const v = await createPanelVersion(db, { label: "2026-12 v1", catalog: bigCatalog(), now: T0 });
  assert.equal(v.size, 40);
  const p = await getPanel(db, v.id);
  assert.equal(p.queries.length, 40);
  await assert.rejects(db.query("UPDATE panel_queries SET query_text = 'changed' WHERE id = $1", [p.queries[0].id]), /append-only/);
  await assert.rejects(db.query("DELETE FROM panel_queries"), /append-only/);
  await assert.rejects(db.query("UPDATE panel_versions SET label = 'x'"), /append-only/);
  await assert.rejects(createPanelVersion(db, { label: "2026-12 v1", catalog: bigCatalog() }), /unique|duplicate/i, "labels are unique");
  await assert.rejects(createPanelVersion(db, { label: " ", catalog: bigCatalog() }), /label/);
  await close();
});
