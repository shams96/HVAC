// The website request form (src/components/RequestForm.astro) posts exactly these payloads to POST /api/leads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newDb, T0 } from "./helpers.mjs";
import { buildServer } from "../src/server.mjs";

async function setup() {
  const { db, close } = await newDb();
  const app = await buildServer({ db, staffToken: "t".repeat(40), now: () => T0, intakeLimit: 100 });
  const post = async (payload) => { const r = await app.inject({ method: "POST", url: "/api/leads", payload }); let json = null; try { json = r.json(); } catch { /* none */ } return { status: r.statusCode, json }; };
  return { db, post, close };
}

// Shape built by the form's submit handler.
const formBody = (o = {}) => ({
  type: "B2C", channel: "form", serviceLine: "cooling", zip: "75201", name: "Sample Person", emergency: false,
  details: { description: "Unit blows warm air" }, source: "website-form", website: "", phone: "(214) 555-0123", ...o,
});

test("home request stores channel, source, ZIP, service line and urgency", async () => {
  const { db, post, close } = await setup();
  const r = await post(formBody({ emergency: true }));
  assert.equal(r.status, 201);
  const row = (await db.query("SELECT channel, source, zip, service_line, emergency FROM leads")).rows[0];
  assert.deepEqual({ ...row }, { channel: "form", source: "website-form", zip: "75201", service_line: "cooling", emergency: true });
  await close();
});

test("consent is recorded with the wording version only for boxes that were ticked", async () => {
  const { db, post, close } = await setup();
  await post(formBody({ consents: [{ channel: "sms", wordingVersion: "v1" }] }));
  const rows = (await db.query("SELECT channel, status, wording_version FROM consent_records")).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { channel: "sms", status: "granted", wording_version: "v1" });
  await close();
});

test("no ticked boxes means no consent record", async () => {
  const { db, post, close } = await setup();
  await post(formBody());
  assert.equal((await db.query("SELECT count(*)::int AS n FROM consent_records")).rows[0].n, 0);
  await close();
});

test("email alone is enough; commercial request needs and stores a company", async () => {
  const { db, post, close } = await setup();
  const { phone, ...noPhone } = formBody({ email: "ops@example.org" });
  assert.equal((await post(noPhone)).status, 201);
  assert.equal((await post(formBody({ type: "B2B", b2b: { company: "Sample Properties LLC" }, phone: "(214) 555-0188" }))).status, 201);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM accounts WHERE name = 'Sample Properties LLC'")).rows[0].n, 1);
  const bad = await post(formBody({ type: "B2B", phone: "(214) 555-0199" }));
  assert.ok(bad.status >= 400 && bad.status < 500);
  await close();
});

test("rejections the form relies on: no contact, bad ZIP, unknown service", async () => {
  const { post, close } = await setup();
  const { phone, ...none } = formBody();
  assert.ok((await post(none)).status >= 400);
  assert.equal((await post(formBody({ zip: "7520" }))).status, 400);
  assert.equal((await post(formBody({ serviceLine: "Not A Slug!" }))).status, 400);
  await close();
});

test("filled honeypot looks like success but stores nothing", async () => {
  const { db, post, close } = await setup();
  const r = await post(formBody({ website: "http://spam.example" }));
  assert.equal(r.status, 201);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM leads")).rows[0].n, 0);
  await close();
});
