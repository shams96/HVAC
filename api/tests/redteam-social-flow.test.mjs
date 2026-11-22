// RED TEAM: social publishing flow (S1-S4, S6, S7): approval bypass, state machine, races, consent, credentials, audit,
// auth, malformed input, DB-level guarantees, and a differential fuzz against an oracle model of the contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, alice, bob, carol, bot, TOKEN, GOOD, PLATFORMS } from "./social-helpers.mjs";
import { fakePublisher, contentHash, checkPostContent } from "../src/social/routes.mjs";
import * as svc from "../src/social/service.mjs";
import { fixtureCatalog } from "./catalog-fixture.mjs";
import { newDb, T0, minutes } from "./helpers.mjs";
import { rng, sleep } from "./redteam-helpers.mjs";

const cat = fixtureCatalog();
const system = { type: "system", id: "cron" };
const webhook = { type: "webhook", id: "hook" };
const rowOf = async (t, id) => (await t.db.query("SELECT * FROM social_posts WHERE id = $1", [id])).rows[0];
const eventsText = async (t) => JSON.stringify((await t.db.query("SELECT * FROM social_post_events ORDER BY id")).rows);
const delayed = (ms) => Object.fromEntries(PLATFORMS.map((p) => [p, fakePublisher({ delayMs: ms })]));

// =====================================================================================================
// S2 approval bypass
// =====================================================================================================

test("RT-SF1 self-, agent-, system-, webhook- and case-variant approval are all refused; the post stays unpublishable until a distinct person approves", async () => {
  const t = await setup();
  await t.connect("gbp");
  const p = await t.pending({}, alice);
  const attempts = [
    { type: "agent", id: "bob" }, { type: "system", id: "bob" }, { type: "webhook", id: "bob" }, { type: "agent", id: "approver-bot" },
    { type: "user", id: "alice" }, { type: "user", id: "ALICE" }, { type: "user", id: "Alice" },
  ];
  for (const actor of attempts) {
    const r = await t.call("POST", `/posts/${p.id}/approve`, { actor });
    assert.equal(r.status, 403, `${JSON.stringify(actor)} -> ${r.status} ${r.raw.body}`);
  }
  assert.equal(await t.status(p.id), "pending_approval");
  assert.equal((await t.call("POST", `/posts/${p.id}/publish`, { actor: bob })).status, 409);
  assert.equal(t.pubs.gbp.calls.length, 0);
  assert.equal((await rowOf(t, p.id)).approved_by_id, null);
  await t.close();
});

test("RT-SF2 the last editor cannot approve; the creator cannot approve after someone else edited; a third person can", async () => {
  const t = await setup();
  const p = await t.pending({}, alice);
  assert.equal((await t.call("PATCH", `/posts/${p.id}`, { content: `${GOOD} Free estimates.`, actor: bob })).status, 200);
  assert.equal((await t.call("POST", `/posts/${p.id}/submit`, { actor: carol })).status, 200);
  assert.equal((await t.call("POST", `/posts/${p.id}/approve`, { actor: bob })).status, 403, "editor");
  assert.equal((await t.call("POST", `/posts/${p.id}/approve`, { actor: alice })).status, 403, "creator");
  assert.equal((await t.call("POST", `/posts/${p.id}/approve`, { actor: carol })).status, 200);
  const r = await rowOf(t, p.id);
  assert.equal(r.approved_by_id, "carol");
  await t.close();
});

test("RT-SF3 only a person can grant consent or reject; consent grants carrying secrets in scope are refused", async () => {
  const t = await setup();
  for (const actor of [bot, system, webhook]) {
    assert.equal((await t.call("POST", "/connections", { platform: "gbp", scope: ["post"], actor })).status, 403, actor.type);
  }
  const p = await t.pending({}, alice);
  for (const actor of [bot, system, webhook]) assert.equal((await t.call("POST", `/posts/${p.id}/reject`, { actor })).status, 403, actor.type);
  assert.equal(await t.status(p.id), "pending_approval");
  // scope strings that are really credentials
  const stored = [];
  for (const [i, scope] of ["ghp_16C7e42F292c6912E7710c838347Ae178B4a", "AKIAIOSFODNN7EXAMPLE", "sk_live" + "_51HqExampleExampleExample0123"].entries()) {
    const platform = PLATFORMS[i];
    const r = await t.call("POST", "/connections", { platform, scope: [scope], actor: alice });
    if (r.status < 400) stored.push(scope.slice(0, 8));
  }
  assert.deepEqual(stored, [], "credential-shaped scope strings were stored in social_connections");
  await t.close();
});

// =====================================================================================================
// S1 state machine (table-driven)
// =====================================================================================================

const NEXT = {
  draft: { submit: "pending_approval", approve: null, reject: null, publish: null, edit: "draft" },
  pending_approval: { submit: null, approve: "approved", reject: "rejected", publish: null, edit: "draft" },
  approved: { submit: null, approve: null, reject: "rejected", publish: "published", edit: "draft" },
  rejected: { submit: null, approve: null, reject: null, publish: null, edit: "draft" },
  published: { submit: null, approve: null, reject: null, publish: "published", edit: null },
  failed: { submit: null, approve: null, reject: null, publish: null, edit: null },
};
const DO = {
  submit: (t, id) => t.call("POST", `/posts/${id}/submit`, { actor: carol }),
  approve: (t, id) => t.call("POST", `/posts/${id}/approve`, { actor: bob }),
  reject: (t, id) => t.call("POST", `/posts/${id}/reject`, { actor: bob }),
  publish: (t, id) => t.call("POST", `/posts/${id}/publish`, { actor: carol }),
  edit: (t, id) => t.call("PATCH", `/posts/${id}`, { content: `${GOOD} Free estimates.`, actor: carol }),
};
async function build(t, state) {
  if (state === "draft") return t.draft();
  if (state === "pending_approval") return t.pending();
  if (state === "approved") return t.approved();
  if (state === "rejected") { const p = await t.pending(); await t.call("POST", `/posts/${p.id}/reject`, { actor: bob }); return p; }
  const p = await t.approved();
  if (state === "failed") t.pubs.gbp.failNext(new Error("platform said no"));
  await t.call("POST", `/posts/${p.id}/publish`, { actor: carol });
  return p;
}
for (const state of Object.keys(NEXT)) {
  test(`RT-SF4 state machine from '${state}': every action either takes the one allowed step or changes nothing, and only approved->publish calls the platform`, async () => {
    const t = await setup();
    await t.connect("gbp");
    const bad = [];
    for (const [action, want] of Object.entries(NEXT[state])) {
      const p = await build(t, state);
      assert.equal(await t.status(p.id), state, "fixture reached " + state);
      const calls = t.pubs.gbp.calls.length;
      const r = await DO[action](t, p.id);
      const after = await t.status(p.id);
      const wantStatus = want ?? state;
      if (after !== wantStatus) bad.push(`${state} + ${action}: status ${after}, expected ${wantStatus} (http ${r.status})`);
      if (want === null && (r.status < 400 || r.status >= 500)) bad.push(`${state} + ${action}: should be refused, got http ${r.status}`);
      const expectCall = state === "approved" && action === "publish";
      if (t.pubs.gbp.calls.length !== calls + (expectCall ? 1 : 0)) bad.push(`${state} + ${action}: platform call count ${t.pubs.gbp.calls.length - calls}`);
    }
    assert.deepEqual(bad, []);
    await t.close();
  });
}

// =====================================================================================================
// S3 / S6 races
// =====================================================================================================

test("RT-SF5 eight simultaneous publishes post exactly once and nobody gets a 5xx", async () => {
  const t = await setup({ publishers: delayed(150) });
  await t.connect("gbp");
  const p = await t.approved();
  const rs = await Promise.all(Array.from({ length: 8 }, () => t.call("POST", `/posts/${p.id}/publish`, { actor: carol })));
  assert.equal(t.pubs.gbp.calls.length, 1);
  assert.ok(rs.every((r) => r.status < 500), rs.map((r) => r.status).join());
  assert.equal(rs.filter((r) => r.status === 200 && !r.json.alreadyPublished).length, 1, "exactly one real publish");
  assert.equal(await t.status(p.id), "published");
  assert.equal((await t.db.query("SELECT count(*)::int AS n FROM social_post_events WHERE post_id = $1 AND event_type = 'published'", [p.id])).rows[0].n, 1);
  await t.close();
});

test("RT-SF6 three simultaneous approvals by three different people yield one approval, one approver of record, one 'approved' event", async () => {
  const t = await setup();
  const p = await t.pending({}, alice);
  const dave = { type: "user", id: "dave" };
  const rs = await Promise.all([bob, carol, dave].map((actor) => t.call("POST", `/posts/${p.id}/approve`, { actor })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join());
  assert.ok(rs.every((r) => r.status === 200 || r.status === 409));
  const winner = rs.find((r) => r.status === 200).json.post.approvedBy.id;
  assert.equal((await rowOf(t, p.id)).approved_by_id, winner);
  assert.equal((await t.db.query("SELECT count(*)::int AS n FROM social_post_events WHERE post_id = $1 AND event_type = 'approved'", [p.id])).rows[0].n, 1);
  await t.close();
});

test("RT-SF7 approve racing an edit that introduces a banned claim never leaves an approved post that violates policy or mismatches its hash", async () => {
  const t = await setup();
  const bad = [];
  for (let i = 0; i < 8; i++) {
    const p = await t.pending({}, alice);
    const jobs = [
      () => t.call("POST", `/posts/${p.id}/approve`, { actor: carol }),
      () => t.call("PATCH", `/posts/${p.id}`, { content: `We are number one in town! ${GOOD}`, actor: bob }),
    ];
    if (i % 2) jobs.reverse();
    await Promise.all(jobs.map((j) => j()));
    const row = await rowOf(t, p.id);
    if (row.status === "approved") {
      const post = { platform: row.platform, kind: row.kind, content: row.content, media: row.media, sourceReviewId: row.source_review_id };
      if (row.content_hash !== contentHash(post)) bad.push(`iteration ${i}: approved hash does not match content`);
      if (checkPostContent(post, cat).length) bad.push(`iteration ${i}: approved content violates policy`);
    }
  }
  assert.deepEqual(bad, []);
  await t.close();
});

test("RT-SF8 an edit racing a publish can never change what is posted: every platform call carries exactly the approved text", async () => {
  const t = await setup({ publishers: delayed(250) });
  await t.connect("gbp");
  const p = await t.approved();
  const original = p.content;
  const pubJob = t.call("POST", `/posts/${p.id}/publish`, { actor: carol });
  await sleep(40);
  const edit = await t.call("PATCH", `/posts/${p.id}`, { content: `${GOOD} We are number one!`, actor: bob });
  const pub = await pubJob;
  assert.ok(t.pubs.gbp.calls.length <= 1);
  for (const c of t.pubs.gbp.calls) assert.equal(c.content, original, `platform received ${c.content}`);
  assert.ok(pub.status < 500 && edit.status < 500, `${pub.status} ${edit.status}`);
  if (t.pubs.gbp.calls.length === 1) assert.notEqual(edit.status, 200, "an edit was accepted while the original was already being posted");
  await t.close();
});

test("RT-SF9 a publisher that returns the same externalId for two posts cannot strand the second post in 'approved' with a burned attempt, or 5xx", async () => {
  const same = { async publish() { return { externalId: "dup-1" }; } };
  const t = await setup({ publishers: { gbp: same, facebook: same, instagram: same, youtube: same } });
  await t.connect("gbp");
  const a = await t.approved();
  const b = await t.approved();
  assert.equal((await t.call("POST", `/posts/${a.id}/publish`, { actor: carol })).status, 200);
  const r = await t.call("POST", `/posts/${b.id}/publish`, { actor: carol });
  const row = await rowOf(t, b.id);
  const problems = [];
  if (r.status >= 500) problems.push(`second publish returned ${r.status}: ${r.raw.body}`);
  if (row.status === "approved" && row.publish_attempted_at) problems.push("second post is stuck 'approved' with publish_attempted_at set (cannot be retried, edited or rejected, and no terminal event recorded)");
  assert.deepEqual(problems, []);
  await t.close();
});

// =====================================================================================================
// S4 consent
// =====================================================================================================

test("RT-SF10 consent granted for another platform, or revoked and re-granted for a different one, never lets a post out", async () => {
  const t = await setup();
  await t.connect("facebook");
  await t.connect("instagram");
  const p = await t.approved({ platform: "gbp" });
  assert.equal((await t.call("POST", `/posts/${p.id}/publish`, { actor: carol })).status, 403);
  assert.equal(t.pubs.gbp.calls.length + t.pubs.facebook.calls.length + t.pubs.instagram.calls.length, 0);
  await t.connect("gbp");
  assert.equal((await t.call("POST", "/connections/gbp/revoke", { actor: alice })).status, 200);
  assert.equal((await t.call("POST", `/posts/${p.id}/publish`, { actor: carol })).status, 403);
  assert.equal(await t.status(p.id), "approved", "a refused publish does not burn the approved post");
  await t.close();
});

test("RT-SF11 a connection whose consent scope is read-only does not authorise publishing", async () => {
  const t = await setup();
  assert.equal((await t.call("POST", "/connections", { platform: "gbp", scope: ["insights.read", "reviews.read"], actor: alice })).status, 201);
  const p = await t.approved();
  const r = await t.call("POST", `/posts/${p.id}/publish`, { actor: carol });
  assert.notEqual(r.status, 200, "published under a consent whose scope never included posting");
  assert.equal(t.pubs.gbp.calls.length, 0);
  await t.close();
});

// =====================================================================================================
// S6 / S7 audit, credentials, PII
// =====================================================================================================

const SECRET_ERRORS = [
  ["api_key=abcd1234efgh5678ijkl9012mnop", "abcd1234efgh5678ijkl9012mnop"],
  ["password=hunter2hunter2", "hunter2hunter2"],
  ["Authorization: Basic dXNlcjpwYXNzd29yZHNlY3JldA==", "dXNlcjpwYXNzd29yZHNlY3JldA"],
  ["jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk", "eyJzdWIiOiIxMjM0NTY3ODkwIn0"],
  ["token ghp_16C7e42F292c6912E7710c838347Ae178B4a rejected", "ghp_16C7e42F292c6912E7710c838347Ae178B4a"],
  ["slack xoxb" + "-1234567890-0987654321-abcdefghijklmnopqrstuvwx", "xoxb" + "-1234567890-0987654321-abcdefghijklmnopqrstuvwx"],
  ["key AKIAIOSFODNN7EXAMPLE secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
  ["stripe sk_live" + "_51HqExampleExampleExample0123", "sk_live" + "_51HqExampleExampleExample0123"],
  ["Cookie: sessionid=abcdef0123456789abcdef0123456789", "abcdef0123456789abcdef0123456789"],
];
test("RT-SF12 secrets echoed in a platform error are redacted before they reach the post row, the append-only event, or the HTTP response", async () => {
  const t = await setup();
  await t.connect("gbp");
  const leaked = [];
  for (const [msg, needle] of SECRET_ERRORS) {
    const p = await t.approved();
    t.pubs.gbp.failNext(new Error(`401 from platform: ${msg}`));
    const r = await t.call("POST", `/posts/${p.id}/publish`, { actor: carol });
    const dump = r.raw.body + JSON.stringify(await rowOf(t, p.id)) + (await eventsText(t));
    if (dump.includes(needle)) leaked.push(needle.slice(0, 24));
  }
  assert.deepEqual(leaked, []);
  // control: a credential of a format the redactor knows is removed
  const p = await t.approved();
  t.pubs.gbp.failNext(new Error("denied Bearer ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxx"));
  await t.call("POST", `/posts/${p.id}/publish`, { actor: carol });
  assert.ok(!(await eventsText(t)).includes("ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxx"), "control: known token format must be redacted");
  await t.close();
});

test("RT-SF13 post text (possible PII) echoed by a platform error is not copied into the append-only event trail", async () => {
  const t = await setup();
  await t.connect("gbp");
  const canary = "Zebediah Quillfeather";
  const p = await t.approved({ content: `Thanks ${canary} for being so kind! Call (415) 555-0100.` });
  t.pubs.gbp.failNext(new Error(`400 invalid text field: "Thanks ${canary} for being so kind! Call (415) 555-0100."`));
  const r = await t.call("POST", `/posts/${p.id}/publish`, { actor: carol });
  assert.equal(r.status, 502);
  assert.ok(!(await eventsText(t)).includes(canary), "event trail (append-only, cannot be scrubbed) contains post text");
  await t.close();
});

test("RT-SF14 what the platform adapter receives has exactly the documented keys: no actor, no approver, no consent record, no secrets", async () => {
  const t = await setup();
  await t.connect("gbp");
  const p = await t.approved();
  await t.call("POST", `/posts/${p.id}/publish`, { actor: carol });
  assert.deepEqual(Object.keys(t.pubs.gbp.calls[0]).sort(), ["content", "id", "idempotencyKey", "kind", "media", "platform"]);
  await t.close();
});

test("RT-SF15 policy refusals and error bodies never echo post text, and the event trail holds codes and ids only", async () => {
  const t = await setup();
  const canary = "Zebediah Quillfeather";
  const p = await t.draft({ content: `${canary} says we are number one! Only $99 call 212-555-0199` });
  const r = await t.call("POST", `/posts/${p.id}/submit`, { actor: alice });
  assert.equal(r.status, 422);
  assert.ok(!r.raw.body.includes(canary), "422 body echoes post text");
  assert.ok(!r.raw.body.includes("212-555-0199"));
  assert.ok(!(await eventsText(t)).match(/Quillfeather|212-555-0199|number one/));
  await t.close();
});

test("RT-SF16 credentials smuggled into post text are refused before approval", async () => {
  const t = await setup();
  const tokens = ["ghp_16C7e42F292c6912E7710c838347Ae178B4a", "AKIAIOSFODNN7EXAMPLE", "xoxb" + "-1234567890-0987654321-abcdefghijklmnopqrstuvwx", "sk_live" + "_51HqExampleExampleExample0123"];
  const slipped = [];
  for (const tok of tokens) {
    const p = await t.draft({ content: `Seasonal reminder ${tok}` });
    const r = await t.call("POST", `/posts/${p.id}/submit`, { actor: alice });
    if (r.status === 200) slipped.push(tok.slice(0, 8));
  }
  assert.deepEqual(slipped, []);
  await t.close();
});

test("RT-SF17 hidden or direction-control characters cannot reach the platform: refused, or stripped before publish", async () => {
  const t = await setup();
  await t.connect("gbp");
  const hidden = `${GOOD} ‮esrever‬ ​⁠`;
  const p = await t.draft({ content: hidden });
  const sub = await t.call("POST", `/posts/${p.id}/submit`, { actor: alice });
  if (sub.status !== 200) return t.close(); // refused: safe
  await t.call("POST", `/posts/${p.id}/approve`, { actor: bob });
  await t.call("POST", `/posts/${p.id}/publish`, { actor: carol });
  const sent = t.pubs.gbp.calls[0]?.content ?? "";
  assert.ok(!/[‪-‮⁦-⁩​-‏⁠-⁤﻿]/.test(sent), "published text still carries invisible/bidi control characters");
  await t.close();
});

// =====================================================================================================
// forged review provenance
// =====================================================================================================

test("RT-SF18 a review created over HTTP can never become an 'official' testimonial source, however the body is dressed", async () => {
  const t = await setup();
  const r = await t.call("POST", "/reviews", { source: "google", rating: 5, body: "Great work, the technician was on time.", sourceUrl: "https://www.google.com/maps/x", capturedVia: "official_api", externalId: "ext-1", captured_via: "official_api", external_id: "ext-1" });
  assert.ok([201, 400].includes(r.status), String(r.status));
  if (r.status === 201) {
    assert.equal(r.json.review.capturedVia, "manual");
    assert.equal(r.json.review.externalId, null);
    const p = await t.draft({ kind: "testimonial_share", sourceReviewId: r.json.review.id, content: '"Great work, the technician was on time." Thank you!' });
    const s = await t.call("POST", `/posts/${p.id}/submit`, { actor: alice });
    assert.equal(s.status, 422, s.raw.body);
    assert.ok(s.json.violations.some((v) => v.code === "review_not_official"));
  }
  await t.close();
});

test("RT-SF25 swapping the referenced review of an approved testimonial drops the approval and re-runs the policy", async () => {
  const t = await setup();
  await t.connect("gbp");
  const a = await t.officialReview({ body: "Great work, the technician was on time and fixed our heat the same day." });
  const b = await t.officialReview({ body: "Quite slow to respond and the price was higher than expected." });
  const quote = '"Great work, the technician was on time and fixed our heat the same day." Thank you!';
  const p = await t.approved({ kind: "testimonial_share", sourceReviewId: a.id, content: quote });
  assert.equal(p.status, "approved");
  const swap = await t.call("PATCH", `/posts/${p.id}`, { sourceReviewId: b.id, actor: carol });
  assert.equal(swap.status, 200);
  assert.equal(await t.status(p.id), "draft", "approval survived swapping the source review");
  assert.equal((await t.call("POST", `/posts/${p.id}/publish`, { actor: carol })).status, 409);
  const resubmit = await t.call("POST", `/posts/${p.id}/submit`, { actor: carol });
  assert.equal(resubmit.status, 422, "quote of review A is not verbatim in review B");
  assert.equal(t.pubs.gbp.calls.length, 0);
  await t.close();
});

test("RT-SF19 mass assignment: status / approver / hash / external id in create or edit bodies never take effect", async () => {
  const t = await setup();
  const forged = { status: "approved", approvedBy: bob, approved_by_id: "bob", approved_by_type: "user", contentHash: "a".repeat(64), content_hash: "a".repeat(64), externalId: "x1", external_id: "x1", publishAttemptedAt: T0.toISOString(), createdBy: bob };
  const c = await t.call("POST", "/posts", { platform: "gbp", kind: "update", content: GOOD, actor: alice, ...forged });
  if (c.status === 201) {
    const r = await rowOf(t, c.json.post.id);
    assert.equal(r.status, "draft");
    assert.equal(r.approved_by_id, null);
    assert.equal(r.content_hash, null);
    assert.equal(r.external_id, null);
    assert.equal(r.publish_attempted_at, null);
    assert.equal(r.created_by_id, "alice");
    const e = await t.call("PATCH", `/posts/${c.json.post.id}`, { content: `${GOOD} v2`, actor: carol, ...forged });
    if (e.status === 200) {
      const r2 = await rowOf(t, c.json.post.id);
      assert.equal(r2.status, "draft");
      assert.equal(r2.approved_by_id, null);
      assert.equal(r2.created_by_id, "alice");
    } else assert.equal(e.status, 400);
  } else assert.equal(c.status, 400);
  await t.close();
});

// =====================================================================================================
// auth
// =====================================================================================================

const ROUTES = [
  ["GET", "/connections"], ["POST", "/connections"], ["POST", "/connections/gbp/revoke"], ["POST", "/reviews"], ["GET", "/reviews/1"],
  ["POST", "/posts"], ["GET", "/posts"], ["GET", "/posts/1"], ["GET", "/posts/1/events"], ["PATCH", "/posts/1"],
  ["POST", "/posts/1/submit"], ["POST", "/posts/1/approve"], ["POST", "/posts/1/reject"], ["POST", "/posts/1/publish"],
];
test("RT-SF20 every staff route refuses a missing or wrong token before looking at the body, and near-miss Authorization headers", async () => {
  const t = await setup();
  const bad = [];
  for (const [m, u] of ROUTES) {
    const body = m === "GET" ? undefined : {};
    for (const headers of [{}, { authorization: "Bearer wrong" }]) {
      const r = await t.call(m, u, body, headers);
      if (r.status !== 401) bad.push(`${m} ${u} ${JSON.stringify(headers)} -> ${r.status}`);
    }
  }
  const variants = [`bearer ${TOKEN}`, `Bearer  ${TOKEN}`, `Basic ${TOKEN}`, TOKEN, `Bearer ${TOKEN.slice(0, -1)}`, `Bearer ${TOKEN}x`, `Token ${TOKEN}`, `Bearer ${TOKEN},Bearer ${TOKEN}`];
  for (const authorization of variants) {
    const r = await t.call("GET", "/connections", undefined, { authorization });
    if (r.status !== 401) bad.push(`Authorization ${JSON.stringify(authorization.slice(0, 20))} -> ${r.status}`);
  }
  for (const headers of [{ "x-api-key": TOKEN }, { cookie: `token=${TOKEN}` }, { "x-staff-token": TOKEN }, { "x-forwarded-user": "admin" }]) {
    const r = await t.call("GET", "/connections", undefined, headers);
    if (r.status !== 401) bad.push(`header ${Object.keys(headers)[0]} -> ${r.status}`);
  }
  const q = await t.app.inject({ method: "GET", url: `/api/staff/social/connections?token=${TOKEN}&access_token=${TOKEN}` });
  if (q.statusCode !== 401) bad.push(`token in query -> ${q.statusCode}`);
  const head = await t.app.inject({ method: "HEAD", url: "/api/staff/social/connections" });
  if (head.statusCode !== 401) bad.push(`HEAD without token -> ${head.statusCode}`);
  const ok = await t.call("GET", "/connections");
  assert.equal(ok.status, 200, "control: the real token works");
  assert.deepEqual(bad, []);
  await t.close();
});

test("RT-SF21 path tricks (case, double slashes, dot segments, encoding, trailing slash) never reach a staff handler without the token", async () => {
  const t = await setup();
  const urls = [
    "/API/STAFF/SOCIAL/connections", "//api/staff/social/connections", "/api/staff/social//connections", "/api/staff/social/connections/",
    "/api/staff/social/../social/connections", "/api/staff/social/%2e%2e/social/connections", "/api/staff/social%2Fconnections", "/api/staff/social/connections;x=1",
    "/api/staff/social/connections%00", "/api/staff/social/connections?x=%", "/api/staff/./social/connections", "/api/staff/social/connections/.",
  ];
  const bad = [];
  for (const u of urls) {
    const r = await t.app.inject({ method: "GET", url: u });
    if (r.statusCode >= 200 && r.statusCode < 300) bad.push(`${u} -> ${r.statusCode} ${r.body.slice(0, 60)}`);
    if (r.statusCode >= 500) bad.push(`${u} -> ${r.statusCode}`);
  }
  assert.deepEqual(bad, []);
  await t.close();
});

// =====================================================================================================
// malformed / hostile input
// =====================================================================================================

test("RT-SF22 malformed, overflowing and hostile requests are refused with 4xx, never 5xx, on the staff routes", async () => {
  const t = await setup();
  const J = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const raw = (method, url, payload, headers = J) => t.app.inject({ method, url: `/api/staff/social${url}`, payload, headers });
  const base = { platform: "gbp", kind: "update", content: GOOD, actor: alice };
  const cases = [
    ["huge review id", "POST", "/posts", JSON.stringify({ ...base, kind: "review_reply", sourceReviewId: 1e20 })],
    ["NUL in content", "POST", "/posts", JSON.stringify({ ...base, content: "hello\u0000world" })],
    ["lone surrogate", "POST", "/posts", '{"platform":"gbp","kind":"update","content":"hi \\ud800","actor":{"type":"user","id":"alice"}}'],
    ["numeric media", "POST", "/posts", JSON.stringify({ ...base, media: [123, {}] })],
    ["object content", "POST", "/posts", JSON.stringify({ ...base, content: { a: 1 } })],
    ["array body", "POST", "/posts", "[]"],
    ["null body", "POST", "/posts", "null"],
    ["truncated json", "POST", "/posts", '{"platform":"gbp","kind":'],
    ["deep nesting", "POST", "/posts", "[".repeat(20000)],
    ["proto pollution", "POST", "/posts", `{"__proto__":{"admin":true},"platform":"gbp","kind":"update","content":"x","actor":{"type":"user","id":"alice"}}`],
    ["actor proto", "POST", "/posts/1/approve", '{"actor":{"__proto__":{"type":"user"},"type":"agent","id":"x"}}'],
    ["oversize", "POST", "/posts", JSON.stringify({ ...base, content: "x".repeat(70_000) })],
    ["id overflow", "GET", "/posts/9999999999999999999", undefined],
    ["id 18 nines", "GET", "/posts/999999999999999999", undefined],
    ["id zero", "GET", "/posts/0", undefined],
    ["limit zero", "GET", "/posts?limit=0", undefined],
    ["limit huge", "GET", "/posts?limit=1000000000000", undefined],
    ["bad status", "GET", "/posts?status=bogus", undefined],
    ["array platform", "GET", "/posts?platform[]=gbp&platform[]=youtube", undefined],
    ["proto platform", "POST", "/connections/__proto__/revoke", JSON.stringify({ actor: alice })],
    ["empty patch", "PATCH", "/posts/1", JSON.stringify({ actor: alice })],
    ["scope overflow", "POST", "/connections", JSON.stringify({ platform: "gbp", scope: Array.from({ length: 500 }, (_, i) => `s${i}`), actor: alice })],
    ["review rating float", "POST", "/reviews", JSON.stringify({ source: "google", rating: 4.5, body: "x" })],
    ["review source url inject", "POST", "/reviews", JSON.stringify({ source: "google", rating: 5, body: "x", sourceUrl: "https://google.com@evil.example/" })],
  ];
  const bad = [];
  for (const [name, m, u, body] of cases) {
    const r = await raw(m, u, body);
    if (r.statusCode >= 500) bad.push(`${name} -> ${r.statusCode} ${r.body.slice(0, 100)}`);
  }
  const r = await raw("POST", "/posts", JSON.stringify(base), { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" });
  if (r.statusCode >= 500) bad.push(`text/plain -> ${r.statusCode}`);
  assert.deepEqual(bad, []);
  await t.close();
});

// =====================================================================================================
// DB-level guarantees (defence in depth; reachable by anyone with SQL access, e.g. a compromised service role)
// =====================================================================================================

test("RT-SF23 the audit and consent-proof tables cannot be truncated, deleted from or rewritten even with direct SQL", async () => {
  const t = await setup();
  await t.connect("gbp");
  const rv = await t.officialReview();
  const p = await t.approved();
  await t.call("POST", `/posts/${p.id}/publish`, { actor: carol });
  // rewrites first (rows still exist), then deletes, then truncates, so an earlier success cannot mask a later check
  const statements = [
    "UPDATE social_post_events SET actor_id = 'mallory'", "UPDATE social_connections SET consented_by_id = 'mallory'", `UPDATE reviews SET body = 'edited' WHERE id = ${rv.id}`,
    "DELETE FROM social_post_events", "DELETE FROM social_connections", `DELETE FROM reviews WHERE id = ${rv.id}`,
    "TRUNCATE social_post_events", "TRUNCATE social_connections",
  ];
  const succeeded = [];
  for (const sql of statements) {
    try {
      await t.db.query(sql);
      succeeded.push(sql);
    } catch { /* refused: good */ }
  }
  assert.deepEqual(succeeded, []);
  await t.close();
});

// =====================================================================================================
// differential fuzz against an oracle model of the contract
// =====================================================================================================

const sameActor = (a, b) => String(a).normalize("NFKC").trim().toLowerCase() === String(b).normalize("NFKC").trim().toLowerCase();

async function socialFuzz(seed, steps) {
  const R = rng(seed);
  const { db, close } = await newDb();
  let clock = T0;
  const consent = { gbp: false, facebook: false };
  const calls = [];
  let failing = false;
  const pubFor = (platform) => ({
    async publish(p) {
      calls.push({ id: p.id, platform, content: p.content, consent: consent[platform] });
      if (failing) { failing = false; throw new Error("platform said no"); }
      return { externalId: `${platform}-${p.id}` };
    },
  });
  const deps = { catalog: cat, publishers: { gbp: pubFor("gbp"), facebook: pubFor("facebook") }, now: () => clock };
  const ACTORS = [alice, bob, carol, bot, system, webhook, { type: "user", id: "ALICE" }, { type: "user", id: "dave" }, { type: "user", id: "Bob" }];
  const CONTENTS = [GOOD, "Free estimates every weekday. Call (415) 555-0100.", "Tune-up only $99!", "We are number one in town", "Spring reminder: tune-ups are $129.", "As a customer I love them", "Call 212/555/0199 today"];
  const posts = new Map();
  const problems = [];
  const violates = (p) => checkPostContent({ platform: p.platform, kind: "update", content: p.content, media: [], sourceReviewId: null }, cat).length > 0;
  const attempt = async (name, expectOk, fn) => {
    let ok = true;
    let out;
    try { out = await fn(); } catch (e) { ok = false; out = e; }
    if (ok !== expectOk) problems.push(`${name}: expected ${expectOk ? "success" : "refusal"}, got ${ok ? "success" : `refusal (${out?.code ?? out?.message})`}`);
    return { ok, out };
  };

  for (let s = 0; s < steps; s++) {
    const op = R.next();
    const actor = R.pick(ACTORS);
    const ids = [...posts.keys()];
    if (op < 0.12 || !ids.length) {
      const platform = R.pick(["gbp", "facebook"]);
      const content = R.pick(CONTENTS);
      const { ok, out } = await attempt(`#${s} create`, true, () => svc.createPost(db, { platform, kind: "update", content, media: [] }, actor, { catalog: cat, now: clock }));
      if (ok) posts.set(out.post.id, { id: out.post.id, platform, content, status: "draft", creator: actor.id, editor: actor.id, calls: 0 });
      continue;
    }
    if (op < 0.84) {
      const id = R.pick(ids);
      const m = posts.get(id);
      const tag = `#${s} post ${id} [${m.status}] by ${actor.type}:${actor.id}`;
      const kind = R.pick(["edit", "submit", "approve", "approve", "reject", "publish", "publish"]);
      if (kind === "edit") {
        const content = R.pick(CONTENTS);
        const closed = m.status === "published" || m.status === "failed";
        const { ok } = await attempt(`${tag} edit`, !closed, () => svc.editPost(db, id, { content }, actor, { catalog: cat, now: clock }));
        if (ok) Object.assign(m, { content, status: "draft", editor: actor.id });
      } else if (kind === "submit") {
        const can = m.status === "draft" && !violates(m);
        const { ok } = await attempt(`${tag} submit`, can, () => svc.submitPost(db, id, actor, { catalog: cat, now: clock }));
        if (ok) m.status = "pending_approval";
      } else if (kind === "approve") {
        const can = m.status === "pending_approval" && actor.type === "user" && !sameActor(actor.id, m.creator) && !sameActor(actor.id, m.editor) && !violates(m);
        const { ok } = await attempt(`${tag} approve`, can, () => svc.approvePost(db, id, actor, { catalog: cat, now: clock }));
        if (ok) m.status = "approved";
      } else if (kind === "reject") {
        const can = actor.type === "user" && (m.status === "pending_approval" || m.status === "approved");
        const { ok } = await attempt(`${tag} reject`, can, () => svc.rejectPost(db, id, actor, "no", { now: clock }));
        if (ok) m.status = "rejected";
      } else {
        const already = m.status === "published";
        const can = already || (m.status === "approved" && consent[m.platform] && !violates(m));
        failing = can && !already && R.chance(0.2);
        const before = calls.length;
        const { ok, out } = await attempt(`${tag} publish`, can, () => svc.publishPost(db, deps, id, actor));
        failing = false;
        if (ok && !already) { m.calls += calls.length - before; m.status = out.failed ? "failed" : "published"; }
        if (already && calls.length !== before) problems.push(`${tag}: a published post hit the platform again`);
        if (!can && calls.length !== before) problems.push(`${tag}: platform was called although the model says it must refuse`);
      }
      const row = (await db.query("SELECT status FROM social_posts WHERE id = $1", [id])).rows[0];
      if (row.status !== m.status) problems.push(`${tag}: db status ${row.status}, model ${m.status}`);
    } else if (op < 0.94) {
      const platform = R.pick(["gbp", "facebook"]);
      const can = actor.type === "user" && !consent[platform];
      const { ok } = await attempt(`#${s} grant ${platform} by ${actor.type}`, can, () => svc.grantConnection(db, { platform, scope: ["post"] }, actor, { now: clock }));
      if (ok) consent[platform] = true;
    } else if (op < 0.98) {
      const platform = R.pick(["gbp", "facebook"]);
      const { ok } = await attempt(`#${s} revoke ${platform}`, consent[platform], () => svc.revokeConnection(db, platform, actor, { now: clock }));
      if (ok) consent[platform] = false;
    } else {
      clock = minutes(Math.round((clock.getTime() - T0.getTime()) / 60_000) + R.int(1, 90));
    }
  }
  for (const [id, m] of posts) {
    const n = calls.filter((c) => c.id === id).length;
    if (n > 1) problems.push(`post ${id} hit the platform ${n}x`);
    if (n === 1 && !["published", "failed"].includes(m.status)) problems.push(`post ${id} hit the platform but is ${m.status}`);
  }
  for (const c of calls) if (!c.consent) problems.push(`post ${c.id} was published without active consent`);
  const bad = (await db.query("SELECT id FROM social_posts WHERE status IN ('approved','published') AND (approved_by_type <> 'user' OR lower(btrim(approved_by_id)) = lower(btrim(created_by_id)))")).rows;
  if (bad.length) problems.push(`approved without a distinct human: ${bad.map((b) => b.id)}`);
  await close();
  return problems;
}

for (const seed of [7, 99, 2026]) {
  test(`RT-SF24 differential fuzz of create/edit/submit/approve/reject/publish/consent against the contract oracle (seed ${seed})`, async () => {
    assert.deepEqual(await socialFuzz(seed, 220), []);
  });
}
