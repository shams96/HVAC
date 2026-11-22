import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";

const zips = JSON.parse(readFileSync(new URL("../src/data/dfw-zips.json", import.meta.url), "utf8"));
const COUNTIES = new Set(["Dallas", "Tarrant", "Collin", "Denton"]);

test("DFW coverage list: unique five digit Texas ZIPs in the four stated counties", () => {
  assert.ok(zips.length > 150, `expected a full metro list, got ${zips.length}`);
  const seen = new Set();
  for (const z of zips) {
    assert.match(z.zip, /^7[56]\d{3}$/, z.zip);
    assert.ok(COUNTIES.has(z.county), `${z.zip} county ${z.county}`);
    assert.ok(!seen.has(z.zip), `duplicate ${z.zip}`);
    seen.add(z.zip);
  }
});

test("DFW coverage list: well known ZIPs land in the right county (spot checks against real geography)", () => {
  const by = new Map(zips.map((z) => [z.zip, z.county]));
  assert.equal(by.get("75201"), "Dallas"); // downtown Dallas
  assert.equal(by.get("76102"), "Tarrant"); // downtown Fort Worth
  assert.equal(by.get("75024"), "Collin"); // Plano
  assert.equal(by.get("76201"), "Denton"); // Denton
  assert.equal(by.has("90210"), false);
  assert.equal(by.has("77002"), false); // Houston is not DFW
});

test("stock photos: every credited image has both sizes on disk, and LICENSES.md names the licence and the no-team rule", () => {
  const dir = new URL("../public/img/", import.meta.url);
  const lic = readFileSync(new URL("LICENSES.md", dir), "utf8");
  const ids = [...lic.matchAll(/\| pexels-(\d+) \|/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5);
  for (const id of ids) for (const w of [800, 1600]) assert.ok(existsSync(new URL(`pexels-${id}-${w}.webp`, dir)), `missing ${id} ${w}`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".webp"));
  for (const f of files) assert.ok(ids.some((id) => f.startsWith(`pexels-${id}-`)), `${f} is not credited in LICENSES.md`);
  assert.match(lic, /Pexels licence/);
  assert.match(lic, /never be described as our team/);
});

test("pages only reference photos that exist", () => {
  const dir = new URL("../public/img/", import.meta.url);
  const src = readFileSync(new URL("../src/pages/index.astro", import.meta.url), "utf8");
  const ids = new Set([...src.matchAll(/(?:id=|photo: )"(\d{6,9})"/g)].map((m) => m[1]));
  assert.ok(ids.size >= 4, `found ${ids.size} photo ids`);
  for (const id of ids) assert.ok(existsSync(new URL(`pexels-${id}-1600.webp`, dir)), `index.astro uses missing photo ${id}`);
});
