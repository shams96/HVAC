import { test } from "node:test";
import assert from "node:assert/strict";
// Mirrors the escaping in Base.astro: "<" must never appear raw inside the JSON-LD script body.
const esc = (j) => JSON.stringify(j).replace(/</g, "\\u003c");
test("JSON-LD escaping neutralizes </script>", () => {
  const out = esc({ name: "</script><script>alert(1)</script>" });
  assert.equal(out.includes("<"), false);
  assert.deepEqual(JSON.parse(out), { name: "</script><script>alert(1)</script>" });
});
