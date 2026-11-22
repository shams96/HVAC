import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDollarAmounts, amountsApproved, validateCatalog, emptyCatalog, loadCatalog } from "../src/catalog.mjs";
import { fixtureCatalog } from "./catalog-fixture.mjs";

test("dollar amount extraction", () => {
  assert.deepEqual(extractDollarAmounts("It costs $1,299.50 or 80 dollars, maybe 5 USD"), [1299.5, 80, 5]);
  assert.deepEqual(extractDollarAmounts("call 415-555-0100 for 2 systems"), []);
});
test("only owner-approved prices pass", () => {
  const c = fixtureCatalog();
  assert.equal(amountsApproved("A tune-up is $129.", c), true);
  assert.equal(amountsApproved("A tune-up is $99.", c), false);
  assert.equal(amountsApproved("Free estimates, no prices quoted.", c), true);
  assert.equal(amountsApproved("Repair is $50", c), false, "free-estimate services have no approved dollar amount");
});
test("catalog validation and empty default", () => {
  assert.throws(() => validateCatalog({ ...emptyCatalog(), services: [{ slug: "Bad Slug", pricing: { kind: "free-estimate" } }] }), /slug/);
  assert.throws(() => validateCatalog({ ...emptyCatalog(), areas: [{ zip: "1" }] }), /zip/);
  assert.deepEqual(loadCatalog(new URL("file:///nonexistent/catalog.json")).services, []);
});

test("extractor reads prices in other digit scripts and currency words (defence in depth, independent of callers)", () => {
  assert.deepEqual(extractDollarAmounts("$٩٩"), [99], "Arabic-Indic digits");
  assert.deepEqual(extractDollarAmounts("$९९"), [99], "Devanagari digits");
  assert.deepEqual(extractDollarAmounts("99 US dollars"), [99]);
  assert.deepEqual(extractDollarAmounts("USD: 99"), [99]);
  assert.deepEqual(extractDollarAmounts("99$"), [99]);
});
