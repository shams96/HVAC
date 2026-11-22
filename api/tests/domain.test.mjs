import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, normalizeEmail } from "../src/domain/phone.mjs";
import { canTransition, initialStage, isTerminal } from "../src/domain/stages.mjs";
import { slaMinutes, slaDue, DEFAULT_SLA } from "../src/domain/sla.mjs";
import { pickRoute } from "../src/domain/routing.mjs";
import { canContact } from "../src/domain/consent.mjs";

test("phone formats normalize to the same E.164", () => {
  for (const v of ["(415) 555-0100", "415-555-0100", "+1 415 555 0100", "1.415.555.0100", "4155550100"])
    assert.equal(normalizePhone(v), "+14155550100");
});
test("invalid phones rejected", () => {
  for (const v of ["", null, "123", "(015) 555-0100", "(415) 055-0100", "415555010", "415555010099"])
    assert.equal(normalizePhone(v), null, String(v));
});
test("email normalizes and rejects junk", () => {
  assert.equal(normalizeEmail("  Ann@Example.ORG "), "ann@example.org");
  for (const v of ["", "a@b", "no at", "a@@b.com", null]) assert.equal(normalizeEmail(v), null, String(v));
});

test("stage graphs", () => {
  assert.equal(initialStage("B2C"), "new");
  assert.equal(initialStage("B2B"), "lead");
  assert.ok(canTransition("B2C", "new", "contacted"));
  assert.ok(!canTransition("B2C", "new", "won"));
  assert.ok(!canTransition("B2B", "lead", "quote"), "cannot skip site_visit");
  assert.ok(canTransition("B2B", "negotiation", "quote"));
  assert.ok(!canTransition("B2B", "won", "lead"), "terminal stays terminal");
  assert.ok(!canTransition("B2C", "lead", "site_visit"), "wrong type vocabulary");
  assert.ok(isTerminal("won") && isTerminal("lost") && !isTerminal("quote"));
});

test("sla minutes", () => {
  assert.equal(slaMinutes("B2C", "form", false), 60);
  assert.equal(slaMinutes("B2C", "call", false), 15);
  assert.equal(slaMinutes("B2C", "form", true), 15, "emergency overrides");
  assert.equal(slaMinutes("B2B", "form", false), DEFAULT_SLA.b2b);
  assert.equal(slaMinutes("B2B", "form", true), 15);
  assert.throws(() => slaMinutes("B2C", "fax", false), /no SLA/);
  assert.equal(slaDue(new Date("2026-01-01T00:00:00Z"), 15).toISOString(), "2026-01-01T00:15:00.000Z");
});

test("routing: exact, any-service, unrouted", () => {
  const rules = [
    { zip: "00001", service_line: "install", branch_id: "b-install", assignee_group: "sales" },
    { zip: "00001", service_line: "*", branch_id: "b-main", assignee_group: null },
  ];
  assert.deepEqual(pickRoute(rules, "00001", "install"), { branchId: "b-install", assigneeGroup: "sales", routedBy: "zip+service" });
  assert.equal(pickRoute(rules, "00001", "repair").routedBy, "zip");
  assert.equal(pickRoute(rules, "00001", "repair").branchId, "b-main");
  assert.deepEqual(pickRoute(rules, "99999", "repair"), { branchId: null, assigneeGroup: null, routedBy: "unrouted" });
  assert.equal(pickRoute([], "00001", "x").routedBy, "unrouted");
});

test("consent: latest wins, none means no", () => {
  assert.equal(canContact([], "sms"), false);
  assert.equal(canContact([{ channel: "sms", status: "granted" }], "sms"), true);
  assert.equal(canContact([{ channel: "sms", status: "granted" }, { channel: "sms", status: "revoked" }], "sms"), false);
  assert.equal(canContact([{ channel: "sms", status: "revoked" }, { channel: "sms", status: "granted" }], "sms"), true);
  assert.equal(canContact([{ channel: "email", status: "granted" }], "sms"), false);
});
