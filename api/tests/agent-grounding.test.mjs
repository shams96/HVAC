import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, startChat, send, count, logEvents, say, call, tools, always } from "./agent-helpers.mjs";
import { guardReply, SAFE_FALLBACK } from "../src/agent/index.mjs";
import { fixtureCatalog } from "./catalog-fixture.mjs";

const cat = fixtureCatalog();
const guard = (text, o = {}) => guardReply(text, { catalog: cat, ...o });

const BAD_PRICES = [
  "A repair is $99.", "Repair starts at $ 50", "It's 79 dollars", "about 200 USD", "only 40 bucks", "$129k for a tune-up", "$1,299.50", "$129.01", "$12.9",
  "USD 129", "129$", "€129", "£100", "one hundred dollars", "a hundred bucks", "fifty dollars off", "two hundred and fifty dollars", "$99/month financing", "＄ 99", "just $​99",
  "$129 or $99 if you book today", "install is $5,000", "Tune-up is 129k dollars", "1.5k bucks",
];

test("A6: any currency amount that is not an owner-approved price blocks the reply", () => {
  const leaked = BAD_PRICES.filter((t) => guard(t).ok);
  assert.deepEqual(leaked, []);
  for (const t of BAD_PRICES) assert.equal(guard(t).text, SAFE_FALLBACK);
});

test("A6: owner-approved prices and price-free text pass", () => {
  for (const t of ["Our seasonal tune-up is $129.", "A tune-up is $129.00 per visit.", "Repair estimates are free.", "We have 2 services listed and 1 ZIP."]) assert.equal(guard(t).ok, true, t);
});

test("A6: banned claims are blocked case-insensitively", () => {
  for (const t of ["We offer the Guaranteed Lowest Price in town", "We're NUMBER ONE", "We are #1 in the area"]) assert.equal(guard(t).ok, false, t);
});

test("A1/A9: promises of arrival time, guarantees and completed-action claims are blocked", () => {
  const bad = [
    "A technician will arrive within 2 hours.", "We'll be there by 3pm.", "Someone will be at your door tomorrow at 9.", "We can get there in 30 minutes.", "Same-day service is guaranteed.", "I guarantee it.",
    "Your appointment has been booked.", "I've scheduled you for Tuesday.", "Your request was submitted successfully.", "You're all set!", "I confirm your estimate.", "I've sent your request to our team.",
    "The technician is on the way.", "Your confirmation number is 4821.", "Request has been sent", "You are booked for 10am", "I have confirmed your appointment",
  ];
  assert.deepEqual(bad.filter((t) => guard(t).ok), []);
  const fine = ["I prepared a request for you to review. Nothing has been sent yet.", "A team member will contact you to confirm a time.", "I can't guarantee a time; staff will confirm.", "Once you press Confirm, we'll pass it to the team.", "Nothing has been booked."];
  assert.deepEqual(fine.filter((t) => !guard(t).ok), []);
});

test("A6: discounts and promotions the model invents are blocked", () => {
  for (const t of ["I can give you 15% off.", "We'll offer you a discount today.", "Use promo code SAVE10.", "I'll apply a coupon.", "We will waive the fee? we'll give you free repair"]) assert.equal(guard(t).ok, false, t);
});

test("A6: phone numbers, links and coverage claims must come from the catalog", () => {
  assert.equal(guard("Call us at (415) 555-0100.").ok, true, "catalog phone is fine");
  assert.equal(guard("Call us at 415-555-0100.").ok, true);
  assert.equal(guard("Call us at (212) 555-0199.").ok, false, "invented phone");
  assert.equal(guard("Call +1 800 555 0123 now").ok, false);
  assert.equal(guard("I'll use (212) 555-0199 as you said.", { userTexts: ["my number is 212-555-0199"] }).ok, true, "a number the customer typed may be echoed");
  assert.equal(guard("Book at https://example.org/book").ok, true);
  assert.equal(guard("Book at https://evil.example.net/book").ok, false);
  assert.equal(guard("Visit www.cheap-hvac.com").ok, false);
  assert.equal(guard("Visit cheap-hvac.com/deal").ok, false);
  assert.equal(guard("We serve ZIP 00001.", { coverageVerified: false }).ok, false, "no check_coverage result behind it");
  assert.equal(guard("We serve ZIP 00001.", { coverageVerified: true }).ok, true);
  assert.equal(guard("We serve ZIP 90210 too.", { coverageVerified: true }).ok, false, "a ZIP that is not in catalog.areas");
  assert.equal(guard("ZIP 90210 is not listed, so staff will confirm.", { coverageVerified: false }).ok, true);
  assert.equal(guard("We cover the whole state.").ok, false);
});

test("output is plain text: markup is stripped, oversize replies are cut, empty replies fall back", () => {
  const r = guard("Hello <script>alert(1)</script><img src=x onerror=alert(1)> there");
  assert.equal(r.ok, true);
  assert.ok(!/[<>]/.test(r.text));
  assert.ok(guard("a".repeat(5000)).text.length <= 1503);
  assert.equal(guard("").ok, false);
  assert.equal(guard(undefined).ok, false);
  assert.equal(guard("​​").ok, false);
});

test("A6 through the harness: a hostile scripted model never gets a bad price, promise or claim to the customer", async () => {
  const hostile = [
    "Sure! The repair is $49 today only.", "Guaranteed lowest price: $1.", "Your appointment is booked for 9am, the technician will arrive within 30 minutes.", "Call 212-555-0199 for a 40% discount.",
    "We serve ZIP 90210 and every ZIP nationwide.", "I confirm your request has been submitted.", "Visit http://phish.example/pay to confirm.",
  ];
  const t = await setup({ script: (_req, i) => say(hostile[i % hostile.length]) });
  const token = await startChat(t.app);
  for (const h of hostile) {
    const r = (await send(t.app, token, "tell me about repairs")).json();
    assert.equal(r.reply, SAFE_FALLBACK, h);
    assert.equal(r.handoffOffered, true);
  }
  const ev = await logEvents(t.db);
  assert.equal(ev.filter((e) => e.event === "blocked" && e.data.reason === "output_guard").length, hostile.length);
  assert.ok(ev.some((e) => e.data.rules?.includes("unapproved_price")));
  assert.ok(ev.some((e) => e.data.rules?.includes("claims_completed_action")));
  assert.ok(JSON.stringify(ev).indexOf("$49") === -1, "blocked text is not logged");
  assert.equal(await count(t.db, "chat_messages", "role = 'assistant' AND content LIKE '%$49%'"), 0, "blocked text is not stored either");
  await t.close();
});

test("A6 through the harness: a grounded answer using tool facts passes", async () => {
  const t = await setup({
    script: (req) => (req.messages.some((m) => m.role === "tool") ? say("Our Seasonal tune-up is $129. Repair visits start with a free estimate. Yes, we serve ZIP 00001.") : tools(call("get_service_info", { serviceLine: "tuneup" }, "1"), call("check_coverage", { zip: "00001", serviceLine: "tuneup" }, "2"))),
  });
  const token = await startChat(t.app);
  const r = (await send(t.app, token, "how much is a tune-up in 00001?")).json();
  assert.match(r.reply, /\$129/);
  assert.equal((await logEvents(t.db)).length, 0);
  await t.close();
});

test("A6: ZIP coverage claims for a ZIP outside catalog.areas are refused even after a real check", async () => {
  const t = await setup({
    script: (req) => (req.messages.some((m) => m.role === "tool") ? say("We serve ZIP 90210.") : tools(call("check_coverage", { zip: "90210" }))),
  });
  const token = await startChat(t.app);
  const r = (await send(t.app, token, "do you serve 90210?")).json();
  assert.equal(r.reply, SAFE_FALLBACK);
  await t.close();
});

test("model failures never leak: throw, hang, junk shapes and endless tool loops all end in the safe fallback", async () => {
  const cases = {
    throws: () => new Error("sk-live-SECRET-KEY upstream 500"),
    null_: () => null,
    number: () => 42,
    textObject: () => ({ text: { evil: true } }),
    toolCallsNotArray: () => ({ toolCalls: "run everything" }),
    emptyText: () => ({ text: "" }),
    loop: () => tools(call("list_services", {})),
    nullCalls: () => ({ toolCalls: [null, 1, "x", { name: 5 }] , text: "ok"}),
  };
  for (const [name, fn] of Object.entries(cases)) {
    const t = await setup({ script: fn });
    const token = await startChat(t.app);
    const res = await send(t.app, token, "tell me about repairs");
    assert.equal(res.statusCode, 200, name);
    const r = res.json();
    assert.ok(!/SECRET|sk-live|upstream/.test(res.body), `${name}: no error detail`);
    assert.ok(r.reply === SAFE_FALLBACK || name === "nullCalls", `${name}: ${r.reply}`);
    assert.equal(await count(t.db, "leads"), 0);
    if (name === "loop") assert.equal(t.llm.calls.length, 4, "tool loop is capped");
    await t.close();
  }
});

test("a model that never answers times out into the safe fallback", async () => {
  const t = await setup({ script: () => new Promise(() => {}), agentOpts: { llmTimeoutMs: 50 } });
  const token = await startChat(t.app);
  const r = (await send(t.app, token, "tell me about repairs")).json();
  assert.equal(r.reply, SAFE_FALLBACK);
  assert.ok((await logEvents(t.db)).some((e) => e.data.reason === "llm_error"));
  await t.close();
});

test("A6: an empty catalog answers 'not listed' for everything and never invents facts", async () => {
  const { emptyCatalog } = await import("../src/catalog.mjs");
  const t = await setup({ catalog: emptyCatalog(), script: always(call("check_coverage", { zip: "00001" }), "Staff will confirm whether we serve that ZIP.") });
  const token = await startChat(t.app);
  await send(t.app, token, "do you serve 00001");
  const tool = t.llm.calls[1].messages.find((m) => m.role === "tool").content;
  assert.match(tool, /"listed":false/);
  await t.close();
});
