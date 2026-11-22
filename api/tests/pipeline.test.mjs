import { test } from "node:test";
import assert from "node:assert/strict";
import { newDb, T0, minutes, seedRoutes, b2c } from "./helpers.mjs";
import {
  createLead, transitionLead, sweepSlaBreaches, optOut, contactAllowed, getLead, anonymizeExpired, addSite, addAgreement, PipelineError,
} from "../src/repo/leads.mjs";

const rejects = (p, code) => assert.rejects(p, (e) => e instanceof PipelineError && e.code === code, code);
const events = async (db, id) => (await getLead(db, id)).events.map((e) => e.event_type);

test("schema: append-only audit and consent tables reject UPDATE and DELETE", async () => {
  const { db, close } = await newDb();
  await seedRoutes(db);
  const r = await createLead(db, b2c({ consents: [{ channel: "sms", wordingVersion: "v1" }] }), { now: T0 });
  await assert.rejects(db.query("UPDATE lead_events SET actor_id = 'x'"), /append-only/);
  await assert.rejects(db.query("DELETE FROM lead_events"), /append-only/);
  await assert.rejects(db.query("UPDATE consent_records SET status = 'revoked'"), /append-only/);
  await assert.rejects(db.query("DELETE FROM consent_records"), /append-only/);
  assert.ok(r.id);
  await close();
});

test("schema: stage vocabulary and lost-reason are enforced by the database", async () => {
  const { db, close } = await newDb();
  await seedRoutes(db);
  const r = await createLead(db, b2c(), { now: T0 });
  await assert.rejects(db.query("UPDATE leads SET stage = 'quote' WHERE id = $1", [r.id]), /stage_valid_for_type/);
  await assert.rejects(db.query("UPDATE leads SET stage = 'lost' WHERE id = $1", [r.id]), /lost_needs_reason/);
  await close();
});

test("intake: creates lead, routes by zip, sets SLA, writes event and outbox row", async () => {
  const { db, close } = await newDb();
  await seedRoutes(db);
  const r = await createLead(db, b2c(), { now: T0 });
  assert.equal(r.deduped, false);
  assert.equal(r.routedBy, "zip");
  assert.equal(r.branchId, "branch-a");
  assert.equal(r.slaDueAt, minutes(60).toISOString());
  const { events: ev } = await getLead(db, r.id);
  assert.equal(ev[0].event_type, "lead_created");
  assert.equal(ev[0].actor_type, "customer");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM crm_outbox WHERE lead_id = $1", [r.id])).rows[0].n, 1);
  await close();
});

test("routing: exact zip+service wins; unknown zip is unrouted", async () => {
  const { db, close } = await newDb();
  await seedRoutes(db);
  const a = await createLead(db, b2c({ serviceLine: "install", phone: "(415) 555-0111", email: "a@example.org" }), { now: T0 });
  assert.equal(a.routedBy, "zip+service");
  const b = await createLead(db, b2c({ zip: "99999", phone: "(415) 555-0122", email: "b@example.org" }), { now: T0 });
  assert.equal(b.routedBy, "unrouted");
  assert.equal(b.branchId, null);
  await close();
});

test("dedupe: same person in another format attaches to the open lead; different service creates a new lead", async () => {
  const { db, close } = await newDb();
  await seedRoutes(db);
  const first = await createLead(db, b2c(), { now: T0 });
  const again = await createLead(db, b2c({ phone: "+1 415.555.0100", email: null, channel: "call" }), { now: minutes(5) });
  assert.equal(again.deduped, true);
  assert.equal(again.id, first.id);
  assert.deepEqual(await events(db, first.id), ["lead_created", "inquiry_attached"]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM contacts")).rows[0].n, 1);
  const other = await createLead(db, b2c({ serviceLine: "install" }), { now: minutes(6) });
  assert.equal(other.deduped, false);
  assert.notEqual(other.id, first.id);
  await close();
});

test("dedupe: an emergency repeat escalates SLA on the existing lead", async () => {
  const { db, close } = await newDb();
  await seedRoutes(db);
  const first = await createLead(db, b2c(), { now: T0 });
  await createLead(db, b2c({ channel: "call", emergency: true }), { now: minutes(10) });
  const { lead } = await getLead(db, first.id);
  assert.equal(lead.emergency, true);
  assert.equal(new Date(lead.sla_due_at).toISOString(), minutes(25).toISOString());
  assert.ok((await events(db, first.id)).includes("escalated_emergency"));
  await close();
});

test("dedupe: phone and email on two different contacts are NOT merged; flagged for review", async () => {
  const { db, close } = await newDb();
  await seedRoutes(db);
  await createLead(db, b2c({ phone: "(415) 555-0100", email: "one@example.org", serviceLine: "install" }), { now: T0 });
  await createLead(db, b2c({ phone: "(415) 555-0199", email: "two@example.org", serviceLine: "install" }), { now: T0 });
  const r = await createLead(db, b2c({ phone: "(415) 555-0100", email: "two@example.org", serviceLine: "repair" }), { now: T0 });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM contacts")).rows[0].n, 2);
  assert.ok((await events(db, r.id)).includes("needs_review"));
  await close();
});

test("intake: invalid contact info is rejected", async () => {
  const { db, close } = await newDb();
  await rejects(createLead(db, b2c({ phone: "123", email: "nope" }), { now: T0 }), "contact_required");
  await rejects(createLead(db, { ...b2c(), type: "B2B" }, { now: T0 }), "company_required");
  await rejects(createLead(db, b2c({ consents: [{ channel: "carrier-pigeon" }] }), { now: T0 }), "bad_consent_channel");
  await close();
});

test("SLA: sweep flags only still-unanswered leads past due, and is idempotent", async () => {
  const { db, close } = await newDb();
  await seedRoutes(db);
  const emerg = await createLead(db, b2c({ channel: "call", emergency: true, phone: "(415) 555-0131", email: "e@example.org" }), { now: T0 });
  const form = await createLead(db, b2c({ phone: "(415) 555-0132", email: "f@example.org" }), { now: T0 });
  const handled = await createLead(db, b2c({ channel: "call", phone: "(415) 555-0133", email: "h@example.org" }), { now: T0 });
  await transitionLead(db, handled.id, "contacted", { type: "user", id: "dispatcher-1" }, { now: minutes(5) });
  assert.deepEqual(await sweepSlaBreaches(db, minutes(20)), [emerg.id]);
  assert.deepEqual(await sweepSlaBreaches(db, minutes(20)), [], "idempotent");
  assert.deepEqual(await sweepSlaBreaches(db, minutes(61)), [form.id], "form lead breaches later; handled lead never does");
  assert.ok((await events(db, emerg.id)).includes("sla_breached"));
  await close();
});

test("stages: B2C transitions are validated and every one records its actor", async () => {
  const { db, close } = await newDb();
  await seedRoutes(db);
  const r = await createLead(db, b2c(), { now: T0 });
  await rejects(transitionLead(db, r.id, "won", { type: "user", id: "u1" }, { now: minutes(1) }), "invalid_transition");
  await rejects(transitionLead(db, r.id, "contacted", { type: "user", id: "" }, { now: minutes(1) }), "actor_required");
  await rejects(transitionLead(db, r.id, "contacted", { type: "robot", id: "x" }, { now: minutes(1) }), "actor_required");
  await rejects(transitionLead(db, 99999, "contacted", { type: "user", id: "u1" }), "not_found");
  await transitionLead(db, r.id, "contacted", { type: "user", id: "u1" }, { now: minutes(2) });
  await transitionLead(db, r.id, "booked", { type: "agent", id: "intake-agent" }, { now: minutes(3) });
  await rejects(transitionLead(db, r.id, "lost", { type: "user", id: "u1" }, { now: minutes(4) }), "reason_required");
  await transitionLead(db, r.id, "lost", { type: "user", id: "u1" }, { reason: "chose another company", now: minutes(4) });
  await rejects(transitionLead(db, r.id, "contacted", { type: "user", id: "u1" }), "invalid_transition");
  const { events: ev } = await getLead(db, r.id);
  const changes = ev.filter((e) => e.event_type === "stage_changed");
  assert.deepEqual(changes.map((e) => `${e.from_stage}>${e.to_stage}:${e.actor_type}/${e.actor_id}`), [
    "new>contacted:user/u1", "contacted>booked:agent/intake-agent", "booked>lost:user/u1",
  ]);
  await close();
});

test("B2B: account, contact role, sites, agreement, and full stage walk to won", async () => {
  const { db, close } = await newDb();
  await seedRoutes(db);
  const input = b2c({
    type: "B2B", channel: "form", name: "Pat Manager", phone: "(415) 555-0150", email: "pat@propco.example",
    serviceLine: "maintenance-agreement",
    b2b: { company: "PropCo Sample LLC", kind: "property_management", role: "Facilities Manager", sites: [{ label: "Building A", zip: "00001" }, { label: "Building B", zip: "00001" }] },
  });
  const r = await createLead(db, input, { now: T0 });
  const { lead, contact } = await getLead(db, r.id);
  assert.equal(lead.stage, "lead");
  assert.equal(contact.role, "Facilities Manager");
  assert.equal(new Date(lead.sla_due_at).toISOString(), minutes(240).toISOString());
  assert.equal((await db.query("SELECT count(*)::int AS n FROM sites WHERE account_id = $1", [lead.account_id])).rows[0].n, 2);

  // second lead from the same company reuses the account and does not duplicate sites
  await createLead(db, { ...input, phone: "(415) 555-0151", email: "lee@propco.example", serviceLine: "install", b2b: { ...input.b2b, role: "Engineer" } }, { now: T0 });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM accounts")).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM sites")).rows[0].n, 2);

  await rejects(transitionLead(db, r.id, "quote", { type: "user", id: "s1" }), "invalid_transition"); // cannot skip site_visit
  for (const [i, st] of ["site_visit", "quote", "negotiation", "won"].entries()) {
    await transitionLead(db, r.id, st, { type: "user", id: "sales-1" }, { now: minutes(10 + i) });
  }
  const siteId = (await db.query("SELECT id FROM sites WHERE account_id = $1 LIMIT 1", [lead.account_id])).rows[0].id;
  const agId = await addAgreement(db, lead.account_id, { siteId, kind: "annual-maintenance", startsOn: "2026-04-01", endsOn: "2027-03-31" }, T0);
  assert.ok(agId);
  await assert.rejects(addAgreement(db, lead.account_id, { kind: "x", startsOn: "2026-04-01", endsOn: "2026-03-01" }, T0), /check/i);
  await rejects(addSite(db, 99999, { label: "x" }), "not_found");
  const { lead: won, events: ev } = await getLead(db, r.id);
  assert.equal(won.stage, "won");
  assert.ok(won.closed_at);
  assert.equal(ev.filter((e) => e.event_type === "stage_changed").length, 4);
  await close();
});

test("consent: no grant means no contact; opt-out is immediate; later explicit grant restores", async () => {
  const { db, close } = await newDb();
  await seedRoutes(db);
  const r = await createLead(db, b2c({ consents: [] }), { now: T0 });
  assert.equal(await contactAllowed(db, r.contactId, "sms"), false, "no checkbox, no consent");
  const r2 = await createLead(db, b2c({ phone: "(415) 555-0170", email: "c@example.org", consents: [{ channel: "sms", wordingVersion: "v1" }] }), { now: T0 });
  assert.equal(await contactAllowed(db, r2.contactId, "sms"), true);
  assert.equal(await contactAllowed(db, r2.contactId, "email"), false, "consent is per channel");
  await optOut(db, { phone: "415-555-0170", channel: "sms" }, minutes(1));
  assert.equal(await contactAllowed(db, r2.contactId, "sms"), false);
  await createLead(db, b2c({ phone: "(415) 555-0170", email: "c@example.org", serviceLine: "install", consents: [] }), { now: minutes(2) });
  assert.equal(await contactAllowed(db, r2.contactId, "sms"), false, "a later inquiry without a checkbox does not re-enable");
  await createLead(db, b2c({ phone: "(415) 555-0170", email: "c@example.org", serviceLine: "tuneup", consents: [{ channel: "sms", wordingVersion: "v2" }] }), { now: minutes(3) });
  assert.equal(await contactAllowed(db, r2.contactId, "sms"), true, "explicit new grant restores");
  await close();
});

test("opt-out for an unknown person still records a suppression; 'all' covers every channel", async () => {
  const { db, close } = await newDb();
  const [id] = await optOut(db, { email: "Stranger@Example.org", channel: "all" }, T0);
  for (const ch of ["call", "sms", "email", "marketing"]) assert.equal(await contactAllowed(db, id, ch), false);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM consent_records WHERE contact_id = $1", [id])).rows[0].n, 4);
  await rejects(optOut(db, { phone: "bad", channel: "sms" }), "contact_required");
  await close();
});

test("retention: expired all-lost contacts are anonymized; opted-out contacts keep their suppression", async () => {
  const { db, close } = await newDb();
  await seedRoutes(db);
  const old = new Date("2023-01-01T00:00:00Z");
  const a = await createLead(db, b2c({ phone: "(415) 555-0180", email: "old@example.org", details: { note: "pii" } }), { now: old });
  await transitionLead(db, a.id, "lost", { type: "user", id: "u1" }, { reason: "no answer", now: old });
  const b = await createLead(db, b2c({ phone: "(415) 555-0181", email: "stop@example.org" }), { now: old });
  await transitionLead(db, b.id, "lost", { type: "user", id: "u1" }, { reason: "no answer", now: old });
  await optOut(db, { phone: "(415) 555-0181", channel: "all" }, old);
  const c = await createLead(db, b2c({ phone: "(415) 555-0182", email: "recent@example.org" }), { now: T0 });
  assert.equal(await anonymizeExpired(db, T0), 1);
  const gone = (await getLead(db, a.id)).contact;
  assert.deepEqual([gone.name, gone.phone_e164, gone.email], [null, null, null]);
  assert.ok(gone.anonymized_at);
  assert.deepEqual((await getLead(db, a.id)).lead.details, {});
  assert.equal((await getLead(db, b.id)).contact.phone_e164, "+14155550181", "suppression identifier kept");
  assert.equal((await getLead(db, c.id)).contact.phone_e164, "+14155550182", "recent contact untouched");
  assert.equal(await anonymizeExpired(db, T0), 0, "idempotent");
  await close();
});
