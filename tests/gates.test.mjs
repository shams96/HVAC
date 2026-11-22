import { test } from "node:test";
import assert from "node:assert/strict";
import { validateServiceAreas, validateServices } from "../src/lib/gates.mjs";

const goodArea = (o = {}) => ({
  zip: "00001", city: "A", state: "XX", branchId: "b1", status: "active", travelBand: "0-15",
  serviceLines: ["repair"], slug: "a-00001", lastVerified: "2026-01-01",
  localJobs: [{ summary: "job one", approved: true }],
  localFacts: [{ text: "fact", sourceUrl: "https://example.org/x", sourceLabel: "src" }],
  ...o,
});

test("valid active area passes", () => assert.deepEqual(validateServiceAreas([goodArea()]), []));
test("planned area needs no content", () =>
  assert.deepEqual(validateServiceAreas([goodArea({ status: "planned", localJobs: [], localFacts: [] })]), []));
test("active area without approved job fails", () =>
  assert.match(validateServiceAreas([goodArea({ localJobs: [{ summary: "x", approved: false }] })])[0], /approved local job/));
test("active area without sourced fact fails", () =>
  assert.match(validateServiceAreas([goodArea({ localFacts: [{ text: "t", sourceUrl: "", sourceLabel: "s" }] })])[0], /sourced local fact/));
test("duplicate zip fails", () =>
  assert.ok(validateServiceAreas([goodArea(), goodArea({ slug: "b" })]).some((e) => /duplicate zip/i.test(e))));
test("duplicate slug fails", () =>
  assert.ok(validateServiceAreas([goodArea(), goodArea({ zip: "00002" })]).some((e) => /duplicate slug/i.test(e))));
test("job copy shared across ZIPs fails (no templated spinning)", () =>
  assert.ok(validateServiceAreas([goodArea(), goodArea({ zip: "00002", slug: "b" })]).some((e) => /copied across/i.test(e))));
test("bad zip format fails", () =>
  assert.ok(validateServiceAreas([goodArea({ zip: "123" })]).some((e) => /5 digits/.test(e))));

const goodSvc = (o = {}) => ({
  slug: "repair", name: "Repair", approved: true, directAnswer: "d", whoFor: "w",
  typicalScope: ["a"], priceDrivers: ["p"], pricing: { kind: "free-estimate" }, ...o,
});
test("valid service passes", () => assert.deepEqual(validateServices([goodSvc()]), []));
test("unapproved service fails", () => assert.ok(validateServices([goodSvc({ approved: false })]).length > 0));
test("approved pricing needs an amount", () =>
  assert.ok(validateServices([goodSvc({ pricing: { kind: "approved" } })]).some((e) => /amount/.test(e))));
test("unknown pricing kind fails", () =>
  assert.ok(validateServices([goodSvc({ pricing: { kind: "from $99!" } })]).length > 0));
