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
  assert.match(page, /api\s*\?\s*<>[\s\S]*<RequestForm/);
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

import { phoneError, buildQuickBody } from "../src/lib/quick-request.mjs";
import { SYMPTOMS, triage, symptomError, needsRiskQuestions, symptomById } from "../src/lib/triage.mjs";

test("triage list: unique ids, valid service lines, a safety alert on every safety item and none elsewhere", () => {
  assert.equal(new Set(SYMPTOMS.map((s) => s.id)).size, SYMPTOMS.length);
  for (const s of SYMPTOMS) {
    assert.ok(["cooling", "heating", "other"].includes(s.serviceLine), s.id);
    assert.ok(["safety", "down", "urgent", "soon", "routine"].includes(s.level), s.id);
    assert.equal(Boolean(s.alert), s.level === "safety", `${s.id}: alert only on safety items`);
  }
  for (const id of ["gas-smell", "co-alarm", "smoke-sparks"]) assert.match(symptomById(id).alert, /911/);
});

test("triage levels: safety and risk answers raise priority, plain outages and planned work do not", () => {
  assert.deepEqual([triage({ symptom: "gas-smell" }).level, triage({ symptom: "gas-smell" }).emergency], ["safety", true]);
  assert.deepEqual([triage({ symptom: "no-cooling" }).level, triage({ symptom: "no-cooling" }).emergency], ["urgent", true]);
  assert.equal(triage({ symptom: "no-cooling", atRisk: true }).atRisk, true);
  assert.deepEqual([triage({ symptom: "no-heating" }).level, triage({ symptom: "no-heating" }).emergency], ["urgent", true]);
  assert.equal(triage({ symptom: "no-heating", unsafeTemp: true }).unsafeTemp, true);
  assert.equal(triage({ symptom: "no-heating", unsafeTemp: true }).emergency, true);
  assert.equal(triage({ symptom: "commercial-cooling-failed" }).level, "urgent");
  // risk answers only count for a system that is not running; they cannot be smuggled onto routine work
  assert.deepEqual([triage({ symptom: "maintenance", atRisk: true }).level, triage({ symptom: "maintenance", atRisk: true }).atRisk], ["routine", false]);
  assert.equal(triage({ symptom: "no-cooling" }).serviceLine, "cooling");
  assert.equal(triage({ symptom: "bogus" }), null);
  assert.ok(needsRiskQuestions("no-heating") && needsRiskQuestions("no-cooling") && !needsRiskQuestions("water-leak"));
  assert.equal(symptomError(""), "Choose what is happening.");
  assert.equal(symptomError("no-cooling"), null);
});

test("quick request: phone validation and payload match the API contract", () => {
  assert.equal(phoneError(""), "Enter your phone number.");
  assert.match(phoneError("12345"), /10 digit/);
  assert.equal(phoneError("(214) 555-0123"), null);
  assert.equal(phoneError("1 214 555 0123"), null);
  assert.equal(buildQuickBody({ phone: "2145550123", symptom: "" }), null, "a symptom choice is required");
  const b = buildQuickBody({ phone: " 214 555 0123 ", symptom: "no-cooling", atRisk: true });
  assert.deepEqual(Object.keys(b).sort(), ["channel", "details", "emergency", "phone", "serviceLine", "source", "type", "website"]);
  assert.equal(b.source, "website-quick");
  assert.equal(b.serviceLine, "cooling");
  assert.equal(b.emergency, true);
  assert.equal(b.phone, "214 555 0123");
  assert.deepEqual(b.details.triage, { level: "urgent", symptom: "no-cooling", atRisk: true, unsafeTemp: false });
  assert.match(b.details.description, /No cooling.*Vulnerable person/);
  assert.ok(!("name" in b) && !("zip" in b) && !("consents" in b), "no name, ZIP or consent is sent or implied");
});

test("forms use the triage fields, not the old urgent checkbox, and carry no stray visible text", () => {
  const page = readFileSync("src/pages/request.astro", "utf8");
  assert.match(page, /api\s*\?\s*<>\s*<QuickRequest/);
  assert.ok(page.indexOf("<QuickRequest") < page.indexOf("<RequestForm"));
  for (const f of ["src/components/QuickRequest.astro", "src/components/RequestForm.astro"]) {
    const c = readFileSync(f, "utf8");
    assert.ok(c.includes("<TriageFields") && c.includes("symptom"), `${f} must ask what is happening`);
    assert.ok(!/name="urgent"/.test(c), `${f} still has the urgent checkbox`);
    assert.ok(!/Leave this empty|Call me back/.test(c), `${f} has casual or stray text`);
    assert.ok(!/alert\(/.test(c));
  }
  assert.ok(!/name="consent/.test(readFileSync("src/components/QuickRequest.astro", "utf8")));
});
