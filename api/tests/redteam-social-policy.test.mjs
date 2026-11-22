// RED TEAM: S5 content policy (checkPostContent). Each list holds posts that MUST yield a violation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureCatalog } from "./catalog-fixture.mjs";
import { checkPostContent } from "../src/social/routes.mjs";

const cat = fixtureCatalog();
const post = (content, o = {}) => ({ platform: "gbp", kind: "update", content, media: [], sourceReviewId: null, ...o });
const codes = (content, o = {}, ctx = {}) => checkPostContent(post(content, o), cat, ctx).map((v) => v.code);
// items whose verdict contains none of the wanted codes (i.e. escaped the policy)
const unflagged = (list, wanted, o = {}, ctx = {}) => list.filter((t) => !codes(t, o, ctx).some((c) => wanted.includes(c)));
const review = (o = {}) => ({ id: 7, source: "google", rating: 5, body: "Great work, the technician was on time and fixed our heat the same day.", sourceUrl: "https://www.google.com/maps/reviews/x", capturedVia: "official_api", ...o });
const share = (content, rv = review()) => checkPostContent(post(content, { kind: "testimonial_share", sourceReviewId: rv.id }), cat, { review: rv }).map((v) => v.code);

const PRICE = ["unapproved_price", "spelled_price"];

test("RT-P0 controls: clean text passes and a plain unapproved price is caught (so later failures are real)", () => {
  assert.deepEqual(codes("FIXTURE: seasonal tune-ups are $129. Call (415) 555-0100 to book."), []);
  assert.ok(codes("Tune-up only $99!").includes("unapproved_price"));
  assert.ok(codes("Call 212-555-0199").includes("unapproved_phone"));
  assert.ok(codes("We are number one").includes("banned_claim"));
});

test("RT-P1 prices with a trailing symbol, currency-word variants, other currency symbols or emoji are caught", () => {
  assert.deepEqual(unflagged([
    "Tune-up 99$ this month",
    "Tune-up 99 US dollars",
    "Tune-up 99 U.S. dollars",
    "Tune-up 99 Canadian dollars",
    "💲99 tune-up",
    "₹99 tune-up",
    "Tune-up 99 CHF",
    "Tune-up USD: 99",
    "Tune-up 9️⃣9️⃣ bucks",
    "Tune-up 99 euros",
    "Tune-up 99 pesos",
    "Tune-up 99 rupees",
    "Tune-up only 99 flat",
    "The diagnostic costs 99 per visit",
  ], PRICE), []);
});

function ndZeros() {
  const zeros = [];
  let run = 0;
  for (let cp = 0x80; cp <= 0x1ffff; cp++) {
    if (/^\p{Nd}$/u.test(String.fromCodePoint(cp))) {
      run++;
      if (run % 10 === 1) zeros.push(cp);
    } else run = 0;
  }
  return zeros;
}
test("RT-P2 a price written in ANY Unicode decimal-digit script is read as a price (digit-script sweep)", () => {
  const zeros = ndZeros();
  assert.ok(zeros.length > 40, "sweep found digit scripts: " + zeros.length);
  const missed = zeros.filter((z) => !codes(`Tune-up $${String.fromCodePoint(z + 9)}${String.fromCodePoint(z + 9)} today`).some((c) => PRICE.includes(c)));
  assert.deepEqual(missed.map((z) => "U+" + z.toString(16).toUpperCase()), []);
});

test("RT-P3 phone numbers with exotic separators, letters for digits, or vanity forms are caught", () => {
  assert.deepEqual(unflagged([
    "call 212/555/0199",
    "call 212_555_0199",
    "call 212,555,0199",
    "call 212·555·0199",
    "call 212•555•0199",
    "call 212|555|0199",
    "call 212:555:0199",
    "call 212 dash 555 dash 0199",
    "call 212-555-O199",
    "call 2l2-555-0199",
    "call 415-555-HEAT",
    "call 212-555-FIXX",
    "call two one two triple five zero one nine nine",
    "call 212 five five five 0199",
  ], ["unapproved_phone"]), []);
});

test("RT-P4 banned claims disguised with accents, leet, split punctuation are caught", () => {
  assert.deepEqual(unflagged([
    "We are númber one",
    "We are nümber one",
    "We are numb3r 0ne",
    "We are # 1",
    "We are # 1",
    "We have the guaranteéd lowest price",
    "We have the guaranteed lowest prïce",
    "We have the guaranteed lowest pr1ce",
    "The g.u.a.r.a.n.t.e.e.d lowest price",
  ], ["banned_claim"]), []);
});

test("RT-P5 invented customer voice in first person, passive praise or fabricated attribution is caught", () => {
  assert.deepEqual(unflagged([
    "Called them at midnight and they came right out. Amazing service!!",
    "10/10 would recommend.",
    "Honestly the best service we've ever received.",
    "Our AC died in July and Sample HVAC saved the day. Thank you!",
    "Our family couldn't be happier with the new system!",
    "I can't say enough good things about this team.",
    "Wow, what a team! I'd call them again in a heartbeat.",
    "Thanks to Sample HVAC our house is finally comfortable again, we are so grateful.",
    "Mike was professional, on time, and left the place spotless.",
    "Sam D. says: they were fast, clean and friendly all the way through!",
    'Maria G. (Sampleville): "They were the only ones who showed up on time."',
    "As a cust0mer I can say this is great",
    "As a c-u-s-t-o-m-e-r I love it",
    "Verified buyer: great service",
    "- Jessica M., Sampleville, happy with the service",
  ], ["customer_voice", "fabricated_testimonial", "invented_rating"]), []);
});

test("RT-P6a a testimonial cannot be built by stitching a negative review into praise with ellipses", () => {
  const neg = review({ rating: 1, body: "This was not great work. The technician was not on time and did not fix our heat." });
  const stitched = share('"great work ... on time ... fix our heat" - Google review', neg);
  assert.ok(stitched.length > 0, "positive testimonial stitched from a 1-star negative review passed with no violation");
});

test("RT-P6b a testimonial cannot quote a fragment whose negation was cut off", () => {
  const trunc = review({ rating: 1, body: "Not the best service, avoid them. Not the best at all." });
  assert.ok(share('"the best service" says our Google reviewer', trunc).length > 0, "negation truncated out of a quote passed");
});

test("RT-P7 a 'testimonial' whose surrounding text claims more than the review does (rating, count, 'all our customers') is caught", () => {
  const rv = review({ rating: 3, body: "Okay service, took a while but they did fix the unit." });
  const out = share('"they did fix the unit" Google review. All of our customers love us, 5-star service!', rv);
  assert.ok(out.includes("invented_rating"), "a 3-star review framed with '5-star service' was accepted: " + out);
});

test("RT-P8 policy runs in bounded time on 5000-char adversarial posts", () => {
  const slow = [];
  const inputs = ["one ".repeat(1250), "1 ".repeat(2500), '"a'.repeat(2500), "as a ".repeat(1000), "$".repeat(5000), "1".repeat(5000), "i ".repeat(2500), "1,".repeat(2500), "( ".repeat(2500), "i used them ".repeat(400), "4 ".repeat(2500), "call ".repeat(1000)];
  for (const s of inputs) {
    const t0 = performance.now();
    checkPostContent(post(s.slice(0, 5000)), cat);
    const dt = performance.now() - t0;
    if (dt > 3000) slow.push(`${s.slice(0, 10)} ${Math.round(dt)}ms`);
  }
  assert.deepEqual(slow, []);
});

test("RT-P9 a post cannot carry platform-specific hazards: too long for the platform, wrong media schemes, credentials in URLs", () => {
  assert.ok(codes("x".repeat(1501), { platform: "gbp" }).includes("too_long"));
  assert.ok(codes("x".repeat(2201), { platform: "instagram" }).includes("too_long"));
  for (const m of ["http://example.org/a.jpg", "javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "https://user:pass@example.org/a.jpg", "file:///etc/passwd", "//example.org/a.jpg", "https://example.org/a.jpg?token=ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxx"]) {
    assert.ok(codes("hello", { media: [m] }).some((c) => ["bad_media", "credential_in_content"].includes(c)), m);
  }
});

test("RT-P10 secrets of well-known token formats are never allowed in post text", () => {
  assert.deepEqual(unflagged([
    "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb" + "-1234567890-0987654321-abcdefghijklmnopqrstuvwx",
    "sk_live" + "_51HqExampleExampleExample0123",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "password=Hunter2Hunter2!!",
    "api_key=abcd1234efgh5678ijkl9012mnop",
  ], ["credential_in_content"]), []);
  // controls: formats it does know
  assert.ok(codes("Bearer ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxx").includes("credential_in_content"));
});
