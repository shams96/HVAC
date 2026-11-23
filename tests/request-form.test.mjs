import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const src = walk("src").filter((f) => /\.(astro|ts|css)$/.test(f));

test("public pages carry no 'pending' action labels", () => {
  for (const f of src) assert.ok(!/(Phone|Booking) pending/.test(readFileSync(f, "utf8")), `${f} still has a pending action label`);
});

test("request form renders only when the lead API is configured, and the link follows the same gate", () => {
  const page = readFileSync("src/pages/request.astro", "utf8");
  assert.match(page, /api\s*\?\s*<RequestForm/);
  assert.match(page, /noindex=\{!api\}/);
  const base = readFileSync("src/layouts/Base.astro", "utf8");
  assert.match(base, /leadsApi && <a class="btn" href="\/request\/"/);
});

test("consent boxes are never pre-checked and the form uses the API's field names", () => {
  const f = readFileSync("src/components/RequestForm.astro", "utf8");
  assert.ok(!/name="consent-(sms|email)"\s*checked/.test(f));
  for (const k of ["channel: \"form\"", "serviceLine", "emergency", "consents", "website:"]) assert.ok(f.includes(k), `missing ${k}`);
  assert.ok(!/alert\(/.test(f));
});
