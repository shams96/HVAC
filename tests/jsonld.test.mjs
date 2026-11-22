import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLocalBusiness, buildService } from "../src/lib/jsonld.mjs";

const full = {
  legalName: "Test Co", phoneDisplay: "(000) 000-0000", phoneE164: "+10000000000", bookingUrl: "https://example.org/book",
  streetAddress: "1 Test St", city: "Testville", state: "XX", postalCode: "00001", hours: null, licenseNumbers: null,
};
const areas = [{ zip: "00001", city: "Testville", state: "XX", status: "active" }, { zip: "00009", city: "Skip", state: "XX", status: "planned" }];

test("returns null when required facts missing", () => {
  assert.equal(buildLocalBusiness({ ...full, legalName: null }, areas, "https://example.org"), null);
  assert.equal(buildLocalBusiness({ ...full, phoneE164: null }, areas, "https://example.org"), null);
});
test("returns null when address incomplete (no partial NAP)", () =>
  assert.equal(buildLocalBusiness({ ...full, streetAddress: null }, areas, "https://example.org"), null));
test("emits only confirmed fields, active areas only", () => {
  const j = buildLocalBusiness(full, areas, "https://example.org");
  assert.equal(j["@type"], "HVACBusiness");
  assert.equal(j.telephone, "+10000000000");
  assert.deepEqual(j.areaServed.map((a) => a.name), ["Testville, XX 00001"]);
  assert.equal("openingHours" in j, false);
  assert.equal("aggregateRating" in j, false);
});
const svc = (pricing) => ({ slug: "r", name: "Repair", approved: true, directAnswer: "answer", pricing });
test("free-estimate service has no Offer price", () => {
  const j = buildService(svc({ kind: "free-estimate" }), full, "https://example.org");
  assert.equal(j.offers.price, undefined);
  assert.match(j.offers.description, /free estimate/i);
});
test("approved price becomes Offer price", () => {
  const j = buildService(svc({ kind: "approved", amount: "129", currency: "USD" }), full, "https://example.org");
  assert.equal(j.offers.price, "129");
});
test("unapproved service yields null", () =>
  assert.equal(buildService({ ...svc({ kind: "free-estimate" }), approved: false }, full, "https://example.org"), null));
test("service null when business facts missing", () =>
  assert.equal(buildService(svc({ kind: "free-estimate" }), { ...full, legalName: null }, "https://example.org"), null));
