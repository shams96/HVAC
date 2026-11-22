// S1 approval flow, S2 human approval, S3 immutability, S4 consent, S6 idempotency/audit, S7 credentials. Safe outcome asserted every time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup, alice, bob, carol, bot, GOOD, auth, PLATFORMS } from "./social-helpers.mjs";
import { fakePublisher, notConfiguredPublisher, contentHash } from "../src/social/routes.mjs";

const events = async (db, id) => (await db.query("SELECT * FROM social_post_events WHERE post_id = $1 ORDER BY id", [id])).rows;

test("S1 happy path: draft > pending > approved > published, one platform call, full audit trail", async () => {
  const t = await setup();
  await t.connect("gbp");
  const d = await t.draft();
  assert.equal(d.status, "draft");
  assert.deepEqual((await t.call("POST", `/posts/${d.id}/submit`, { actor: alice })).json.post.status, "pending_approval");
  const ap = await t.call("POST", `/posts/${d.id}/approve`, { actor: bob });
  assert.equal(ap.json.post.status, "approved");
  assert.equal(ap.json.post.approvedBy.id, "bob");
  const pub = await t.call("POST", `/posts/${d.id}/publish`, { actor: bob });
  assert.equal(pub.status, 200, pub.raw.body);
  assert.equal(pub.json.post.status, "published");
  assert.equal(pub.json.post.externalId, "fake-gbp-1");
  assert.equal(t.pubs.gbp.calls.length, 1);
  assert.equal(t.pubs.gbp.calls[0].content, GOOD);
  assert.deepEqual(Object.keys(t.pubs.gbp.calls[0]).sort(), ["content", "id", "idempotencyKey", "kind", "media", "platform"], "adapter gets the post only, no credentials");
  const ev = await events(t.db, d.id);
  assert.deepEqual(ev.map((e) => `${e.event_type}:${e.actor_type}:${e.actor_id}`), [
    "created:user:alice", "submitted:user:alice", "approved:user:bob", "publish_started:user:bob", "published:user:bob",
  ]);
  await t.close();
});

test("S1 illegal transitions are refused and change nothing", async () => {
  const t = await setup();
  await t.connect("gbp");
  const d = await t.draft();
  for (const step of ["approve", "publish", "reject"]) {
    const r = await t.call("POST", `/posts/${d.id}/${step}`, { actor: bob });
    assert.ok([409, 403].includes(r.status), `${step} on draft -> ${r.status}`);
  }
  assert.equal(await t.status(d.id), "draft");
  assert.equal(t.pubs.gbp.calls.length, 0);

  const p = await t.pending();
  assert.equal((await t.call("POST", `/posts/${p.id}/submit`, { actor: alice })).status, 409, "submit twice");
  assert.equal((await t.call("POST", `/posts/${p.id}/publish`, { actor: bob })).status, 409, "publish pending_approval");
  assert.equal((await t.call("POST", `/posts/${p.id}/reject`, { actor: bob, reason: "no" })).json.post.status, "rejected");
  assert.equal((await t.call("POST", `/posts/${p.id}/approve`, { actor: bob })).status, 409, "approve rejected");
  assert.equal((await t.call("POST", `/posts/${p.id}/publish`, { actor: bob })).status, 409, "publish rejected");
  assert.equal((await t.call("POST", `/posts/${p.id}/submit`, { actor: alice })).status, 409, "submit rejected (must be edited back to draft first)");

  const a = await t.approved();
  assert.equal((await t.call("POST", `/posts/${a.id}/approve`, { actor: carol })).status, 409, "approve twice");
  assert.equal((await t.call("POST", `/posts/${a.id}/submit`, { actor: alice })).status, 409, "submit approved");
  assert.equal(t.pubs.gbp.calls.length, 0);
  await t.close();
});

test("S1 published and failed posts are terminal: no edit, no re-approve, no reject", async () => {
  const t = await setup();
  await t.connect("gbp");
  const a = await t.approved();
  await t.call("POST", `/posts/${a.id}/publish`, { actor: bob });
  assert.equal((await t.call("PATCH", `/posts/${a.id}`, { actor: alice, content: "changed" })).status, 409);
  assert.equal((await t.call("POST", `/posts/${a.id}/reject`, { actor: bob })).status, 409);
  assert.equal((await t.call("POST", `/posts/${a.id}/approve`, { actor: carol })).status, 409);
  assert.equal(await t.status(a.id), "published");

  t.pubs.gbp.failNext(new Error("platform said no"));
  const f = await t.approved();
  const r = await t.call("POST", `/posts/${f.id}/publish`, { actor: bob });
  assert.equal(r.status, 502);
  assert.equal(await t.status(f.id), "failed");
  assert.equal((await t.call("PATCH", `/posts/${f.id}`, { actor: alice, content: "again" })).status, 409, "failed cannot be silently reopened");
  assert.equal((await t.call("POST", `/posts/${f.id}/approve`, { actor: carol })).status, 409);
  await t.close();
});

test("S2 only a person other than the creator can approve", async () => {
  const t = await setup();
  await t.connect("gbp");
  const p = await t.pending({}, alice);
  const tries = [
    ["creator", alice], ["creator, different case", { type: "user", id: "ALICE" }],
    ["agent", { type: "agent", id: "approver-9" }], ["system", { type: "system", id: "cron" }], ["webhook", { type: "webhook", id: "hook" }],
    ["agent using a human's id", { type: "agent", id: "bob" }],
  ];
  for (const [label, actor] of tries) {
    const r = await t.call("POST", `/posts/${p.id}/approve`, { actor });
    assert.equal(r.status, 403, `${label} must be refused, got ${r.status}`);
  }
  assert.equal(await t.status(p.id), "pending_approval");
  assert.equal((await t.call("POST", `/posts/${p.id}/publish`, { actor: bob })).status, 409);
  assert.equal(t.pubs.gbp.calls.length, 0);
  // invalid actor shapes never reach the service
  for (const actor of [{ type: "admin", id: "x" }, { type: "user", id: "" }, { type: "user", id: "bob " }, { type: "user", id: "аlice" }, { id: "bob" }]) {
    assert.equal((await t.call("POST", `/posts/${p.id}/approve`, { actor })).status, 400, JSON.stringify(actor));
  }
  assert.equal((await t.call("POST", `/posts/${p.id}/approve`, {})).status, 400, "no actor");
  const refused = (await events(t.db, p.id)).filter((e) => e.event_type === "approval_refused");
  assert.equal(refused.length, tries.length, "every refused approval is audited");
  assert.equal((await t.call("POST", `/posts/${p.id}/approve`, { actor: bob })).status, 200);
  await t.close();
});

test("S2 an agent may draft but never approve; the last editor cannot approve their own edit", async () => {
  const t = await setup();
  const d = await t.draft({ actor: bot });
  assert.equal(d.createdBy.type, "agent");
  await t.call("POST", `/posts/${d.id}/submit`, { actor: bot });
  assert.equal((await t.call("POST", `/posts/${d.id}/approve`, { actor: bot })).status, 403);
  // bob edits the agent's draft, then tries to approve his own edit
  const e = await t.call("PATCH", `/posts/${d.id}`, { actor: bob, content: `${GOOD} Open weekdays.` });
  assert.equal(e.json.post.status, "draft");
  await t.call("POST", `/posts/${d.id}/submit`, { actor: bob });
  assert.equal((await t.call("POST", `/posts/${d.id}/approve`, { actor: bob })).status, 403, "editor cannot approve");
  assert.equal((await t.call("POST", `/posts/${d.id}/approve`, { actor: carol })).status, 200);
  await t.close();
});

test("S2 database refuses an approved row without a human approver, or approved by its creator", async () => {
  const t = await setup();
  const p = await t.pending();
  const hash = "a".repeat(64);
  const bad = (sql, params) => assert.rejects(t.db.query(sql, params), /approved_needs_human|violates check/);
  await bad("UPDATE social_posts SET status='approved', approved_by_type='agent', approved_by_id='x', approved_at=now(), content_hash=$2 WHERE id=$1", [p.id, hash]);
  await bad("UPDATE social_posts SET status='approved', approved_by_type='user', approved_by_id='ALICE', approved_at=now(), content_hash=$2 WHERE id=$1", [p.id, hash]);
  await bad("UPDATE social_posts SET status='approved', approved_by_type='user', approved_by_id='bob', approved_at=now() WHERE id=$1", [p.id]);
  assert.equal(await t.status(p.id), "pending_approval");
  await t.close();
});

test("S2 reject needs a person", async () => {
  const t = await setup();
  const p = await t.pending();
  assert.equal((await t.call("POST", `/posts/${p.id}/reject`, { actor: bot })).status, 403);
  assert.equal(await t.status(p.id), "pending_approval");
  const r = await t.call("POST", `/posts/${p.id}/reject`, { actor: bob, reason: "tone" });
  assert.equal(r.json.post.status, "rejected");
  assert.equal(r.json.post.approvedBy, null);
  // rejected -> edit -> draft is the only way back
  assert.equal((await t.call("PATCH", `/posts/${p.id}`, { actor: alice, content: `${GOOD} Thanks.` })).json.post.status, "draft");
  await t.close();
});

test("S3 editing an approved post returns it to draft, clears approval, and blocks publishing until re-approved", async () => {
  const t = await setup();
  await t.connect("gbp");
  const a = await t.approved();
  assert.match(a.contentHash, /^[0-9a-f]{64}$/);
  const e = await t.call("PATCH", `/posts/${a.id}`, { actor: carol, content: `${GOOD} Now with extra words.` });
  assert.equal(e.json.post.status, "draft");
  assert.equal(e.json.post.approvedBy, null);
  assert.equal(e.json.post.contentHash, null);
  const row = (await t.db.query("SELECT approved_by_id, approved_at, content_hash FROM social_posts WHERE id=$1", [a.id])).rows[0];
  assert.deepEqual([row.approved_by_id, row.approved_at, row.content_hash], [null, null, null]);
  assert.equal((await t.call("POST", `/posts/${a.id}/publish`, { actor: bob })).status, 409);
  assert.equal(t.pubs.gbp.calls.length, 0);
  assert.ok((await events(t.db, a.id)).some((x) => x.event_type === "edited" && x.data.approval_cleared === true));
  // full cycle again with the new text
  await t.call("POST", `/posts/${a.id}/submit`, { actor: carol });
  const re = await t.call("POST", `/posts/${a.id}/approve`, { actor: bob });
  assert.notEqual(re.json.post.contentHash, a.contentHash, "new text means a new hash");
  assert.equal((await t.call("POST", `/posts/${a.id}/publish`, { actor: bob })).json.post.status, "published");
  assert.match(t.pubs.gbp.calls[0].content, /extra words/);
  await t.close();
});

test("S3 approval hash is SHA-256 of platform, kind, content, media and review; any later tamper blocks publishing", async () => {
  const t = await setup();
  await t.connect("gbp");
  await t.connect("facebook");
  const a = await t.approved({ media: ["https://example.org/a.jpg"] });
  const expected = createHash("sha256").update(JSON.stringify({ v: 1, platform: "gbp", kind: "update", content: GOOD, media: ["https://example.org/a.jpg"], sourceReviewId: null })).digest("hex");
  assert.equal(a.contentHash, expected);
  assert.equal(contentHash({ platform: "gbp", kind: "update", content: GOOD + " ", media: ["https://example.org/a.jpg"] }) === expected, false, "one extra space changes the hash");

  const tampers = [
    ["content", "UPDATE social_posts SET content = content || ' (sneaky)' WHERE id = $1"],
    ["platform", "UPDATE social_posts SET platform = 'facebook' WHERE id = $1"],
    ["media", `UPDATE social_posts SET media = '["https://evil.example/x.jpg"]'::jsonb WHERE id = $1`],
    ["kind", "UPDATE social_posts SET kind = 'offer' WHERE id = $1"],
  ];
  for (const [what, sql] of tampers) {
    const p = await t.approved({ media: ["https://example.org/a.jpg"] });
    await t.db.query(sql, [p.id]);
    const r = await t.call("POST", `/posts/${p.id}/publish`, { actor: bob });
    assert.equal(r.status, 409, `${what} tamper: ${r.raw.body}`);
    assert.equal(r.json.error, "content_changed_after_approval");
    assert.equal(await t.status(p.id), "approved", "stays approved, not published");
  }
  assert.equal(t.pubs.gbp.calls.length + t.pubs.facebook.calls.length, 0, "nothing was posted for any tampered post");
  await t.close();
});

test("S4 publish needs stored consent; revoking blocks immediately, including already-approved posts", async () => {
  const t = await setup();
  const a = await t.approved();
  const noConsent = await t.call("POST", `/posts/${a.id}/publish`, { actor: bob });
  assert.equal(noConsent.status, 403);
  assert.equal(noConsent.json.error, "no_consent");
  assert.equal(t.pubs.gbp.calls.length, 0);

  const c = await t.connect("gbp");
  assert.deepEqual([c.status, c.consentedBy.id], ["granted", "alice"]);
  assert.ok(c.consentedAt);
  assert.deepEqual(c.scope, ["post"]);
  const revoke = await t.call("POST", "/connections/gbp/revoke", { actor: bob });
  assert.equal(revoke.json.connection.status, "revoked");
  assert.equal(revoke.json.connection.revokedBy.id, "bob");
  const after = await t.call("POST", `/posts/${a.id}/publish`, { actor: bob });
  assert.equal(after.status, 403, "approved post cannot publish after revoke");
  assert.equal(t.pubs.gbp.calls.length, 0);
  assert.equal(await t.status(a.id), "approved");

  assert.equal((await t.call("POST", "/connections/gbp/revoke", { actor: bob })).status, 404, "nothing left to revoke");
  // fresh consent is a new row, and then the post may go out
  const again = await t.connect("gbp", carol);
  assert.notEqual(again.id, c.id);
  assert.equal((await t.call("POST", `/posts/${a.id}/publish`, { actor: bob })).status, 200);
  assert.equal((await t.call("GET", "/connections")).json.connections.length, 2, "history of consent is kept");
  await t.close();
});

test("S4 only a person can grant consent; duplicates refused; revoked rows and consent proof cannot be altered", async () => {
  const t = await setup();
  assert.equal((await t.call("POST", "/connections", { platform: "gbp", scope: ["post"], actor: bot })).status, 403);
  assert.equal((await t.call("POST", "/connections", { platform: "gbp", scope: [], actor: alice })).status, 400);
  assert.equal((await t.call("POST", "/connections", { platform: "tiktok", scope: ["post"], actor: alice })).status, 400);
  assert.equal((await t.call("GET", "/connections")).json.connections.length, 0);
  const c = await t.connect("gbp");
  assert.equal((await t.call("POST", "/connections", { platform: "gbp", scope: ["post"], actor: alice })).status, 409);
  // an agent can revoke (safe direction) but the revoked row can never be re-granted in place
  assert.equal((await t.call("POST", "/connections/gbp/revoke", { actor: bot })).status, 200);
  await assert.rejects(t.db.query("UPDATE social_connections SET status='granted', revoked_at=NULL, revoked_by_id=NULL, revoked_by_type=NULL WHERE id=$1", [c.id]), /revoked connection cannot change|violates/);
  await assert.rejects(t.db.query("DELETE FROM social_connections WHERE id=$1", [c.id]), /never deleted/);
  const c2 = await t.connect("youtube");
  await assert.rejects(t.db.query("UPDATE social_connections SET consented_by_id='mallory' WHERE id=$1", [c2.id]), /immutable/);
  await assert.rejects(t.db.query("UPDATE social_connections SET scope='[\"admin\"]'::jsonb WHERE id=$1", [c2.id]), /immutable/);
  await t.close();
});

test("S4 consent is per platform: no cross-platform publishing, each post goes only to its own publisher", async () => {
  const t = await setup();
  await t.connect("gbp");
  const fb = await t.approved({ platform: "facebook" });
  const r = await t.call("POST", `/posts/${fb.id}/publish`, { actor: bob });
  assert.equal(r.status, 403, "gbp consent does not cover facebook");
  assert.equal(t.pubs.facebook.calls.length + t.pubs.gbp.calls.length, 0);
  await t.connect("facebook");
  await t.connect("instagram");
  assert.equal((await t.call("POST", `/posts/${fb.id}/publish`, { actor: bob })).status, 200);
  const ig = await t.approved({ platform: "instagram", media: ["https://example.org/p.jpg"] });
  assert.equal((await t.call("POST", `/posts/${ig.id}/publish`, { actor: bob })).status, 200);
  assert.deepEqual(PLATFORMS.map((p) => t.pubs[p].calls.length), [0, 1, 1, 0]);
  assert.equal(t.pubs.facebook.calls[0].platform, "facebook");
  assert.equal(t.pubs.instagram.calls[0].platform, "instagram");
  await t.close();
});

test("S6 publishing twice posts once, including two simultaneous requests", async () => {
  const t = await setup({ publishers: Object.fromEntries(PLATFORMS.map((p) => [p, fakePublisher({ delayMs: 40 })])) });
  await t.connect("gbp");
  const a = await t.approved();
  const [r1, r2, r3] = await Promise.all([1, 2, 3].map(() => t.call("POST", `/posts/${a.id}/publish`, { actor: bob })));
  const codes = [r1, r2, r3].map((r) => r.status).sort();
  assert.equal(t.pubs.gbp.calls.length, 1, "exactly one platform call");
  assert.equal(codes.filter((c) => c === 200).length, 1, `one winner: ${codes}`);
  assert.ok(codes.every((c) => [200, 409].includes(c)), `losers refused: ${codes}`);
  const again = await t.call("POST", `/posts/${a.id}/publish`, { actor: bob });
  assert.equal(again.status, 200);
  assert.equal(again.json.alreadyPublished, true);
  assert.equal(again.json.post.externalId, "fake-gbp-1");
  assert.equal(t.pubs.gbp.calls.length, 1);
  assert.equal((await t.db.query("SELECT count(*)::int n FROM social_post_events WHERE post_id=$1 AND event_type='published'", [a.id])).rows[0].n, 1);
  await t.close();
});

test("S6 platform failure becomes failed with the error, is not retried, and secrets in the error are redacted", async () => {
  const t = await setup();
  await t.connect("gbp");
  const a = await t.approved();
  t.pubs.gbp.failNext(new Error("401 from API, token ya29.A0ARrdaM-abcdefghijklmnopqrstuvwxyz0123 rejected"));
  const r = await t.call("POST", `/posts/${a.id}/publish`, { actor: bob });
  assert.equal(r.status, 502);
  assert.equal(r.json.post.status, "failed");
  assert.match(r.json.post.error, /401 from API/);
  assert.doesNotMatch(JSON.stringify(r.json) + JSON.stringify(await events(t.db, a.id)), /ya29\./, "token never stored or returned");
  const retry = await t.call("POST", `/posts/${a.id}/publish`, { actor: bob });
  assert.equal(retry.status, 409, "no retry of a failed post");
  assert.equal(t.pubs.gbp.calls.length, 1, "platform called exactly once");
  const ev = await events(t.db, a.id);
  assert.equal(ev.at(-2).event_type, "publish_failed");
  await t.close();
});

test("S6 timeouts and malformed publisher answers fail closed", async () => {
  const slow = { publish: () => new Promise(() => {}) };
  const t = await setup({ publishers: { gbp: slow, facebook: { publish: async () => ({}) }, instagram: fakePublisher(), youtube: fakePublisher() }, publishTimeoutMs: 50 });
  await t.connect("gbp");
  await t.connect("facebook");
  const a = await t.approved();
  const r = await t.call("POST", `/posts/${a.id}/publish`, { actor: bob });
  assert.equal(r.status, 502);
  assert.match(r.json.post.error, /timed out/);
  const b = await t.approved({ platform: "facebook" });
  const r2 = await t.call("POST", `/posts/${b.id}/publish`, { actor: bob });
  assert.equal(r2.status, 502);
  assert.equal(await t.status(b.id), "failed");
  await t.close();
});

test("S6 a crash after claiming leaves the post unpublishable (no double-post), not retried", async () => {
  const t = await setup();
  await t.connect("gbp");
  const a = await t.approved();
  await t.db.query("UPDATE social_posts SET publish_attempted_at = now() WHERE id = $1", [a.id]); // simulate: claimed, process died
  const r = await t.call("POST", `/posts/${a.id}/publish`, { actor: bob });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "publish_already_attempted");
  assert.equal((await t.call("PATCH", `/posts/${a.id}`, { actor: carol, content: "x" })).status, 409, "cannot edit mid-publish");
  assert.equal((await t.call("POST", `/posts/${a.id}/reject`, { actor: bob })).status, 409, "cannot reject mid-publish");
  assert.equal(t.pubs.gbp.calls.length, 0);
  await t.close();
});

test("publisher not configured: refused without burning the approved post", async () => {
  const t = await setup({ publishers: { gbp: notConfiguredPublisher } });
  await t.connect("gbp");
  await t.connect("youtube");
  const a = await t.approved();
  const r = await t.call("POST", `/posts/${a.id}/publish`, { actor: bob });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "publisher_not_configured");
  assert.equal(await t.status(a.id), "approved");
  assert.equal((await t.db.query("SELECT publish_attempted_at FROM social_posts WHERE id=$1", [a.id])).rows[0].publish_attempted_at, null);
  const y = await t.approved({ platform: "youtube", media: ["https://example.org/v.mp4"] });
  assert.equal((await t.call("POST", `/posts/${y.id}/publish`, { actor: bob })).status, 503, "platform with no publisher at all");
  await assert.rejects(notConfiguredPublisher.publish({ platform: "gbp" }), /No publisher is configured/);
  await t.close();
});

test("S6 audit trail is append-only and every event has an actor type and id", async () => {
  const t = await setup();
  await t.connect("gbp");
  const a = await t.approved();
  await t.call("POST", `/posts/${a.id}/publish`, { actor: { type: "system", id: "scheduler" } });
  const ev = await events(t.db, a.id);
  assert.ok(ev.length >= 5);
  for (const e of ev) {
    assert.ok(["user", "agent", "system", "webhook"].includes(e.actor_type));
    assert.ok(e.actor_id.length > 0);
  }
  assert.equal(ev.at(-1).actor_id, "scheduler");
  await assert.rejects(t.db.query("UPDATE social_post_events SET actor_id = 'x' WHERE post_id = $1", [a.id]), /append-only/);
  await assert.rejects(t.db.query("DELETE FROM social_post_events WHERE post_id = $1", [a.id]), /append-only/);
  await assert.rejects(t.db.query("INSERT INTO social_post_events (post_id, at, actor_type, actor_id, event_type) VALUES ($1, now(), 'robot', 'x', 'hack')", [a.id]), /violates check/);
  assert.equal((await t.call("GET", `/posts/${a.id}/events`)).json.events.length, ev.length);
  await t.close();
});

test("S6 events hold ids, hashes and codes, never post text or PII", async () => {
  const t = await setup();
  await t.connect("gbp");
  const a = await t.approved({ content: "FIXTURE: call (415) 555-0100 about our $129 tune-up, ask for Pat" });
  await t.call("POST", `/posts/${a.id}/publish`, { actor: bob });
  const blob = JSON.stringify(await events(t.db, a.id));
  assert.doesNotMatch(blob, /555-0100|Pat|tune-up/);
  await t.close();
});

test("S7 no credential columns anywhere in the social tables; extra body fields are never stored", async () => {
  const t = await setup();
  const cols = (await t.db.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('social_connections','social_posts','social_post_events','reviews')`
  )).rows;
  assert.ok(cols.length > 20);
  const bad = cols.filter((c) => /token|secret|password|credential|api_?key|bearer|refresh|oauth/i.test(c.column_name));
  assert.deepEqual(bad, []);
  const c = await t.call("POST", "/connections", { platform: "gbp", scope: ["post"], actor: alice, accessToken: "ya29.SECRETSECRETSECRETSECRET", refresh_token: "1//0SECRETSECRETSECRETSECRETSECRETSECRET" });
  assert.equal(c.status, 201);
  const dump = JSON.stringify((await t.db.query("SELECT * FROM social_connections")).rows);
  assert.doesNotMatch(dump, /SECRET|ya29/);
  const sneaky = await t.call("POST", "/connections", { platform: "facebook", scope: ["ya29.A0ARrdaM-abcdefghijklmnopqrstuvwxyz0123"], actor: alice });
  assert.equal(sneaky.status, 400, "a token cannot be smuggled in as a scope");
  assert.equal((await t.call("GET", "/connections")).json.connections.length, 1);
  await t.close();
});

test("S7 posts carrying credentials in text or media are refused before approval", async () => {
  const t = await setup();
  const d = await t.draft({ content: `${GOOD} key: sk-abcdefghijklmnopqrstuvwxyz0123456789` });
  const r = await t.call("POST", `/posts/${d.id}/submit`, { actor: alice });
  assert.equal(r.status, 422);
  assert.ok(r.json.violations.some((v) => v.code === "credential_in_content"));
  const m = await t.draft({ media: ["https://example.org/x.jpg?access_token=abc123abc123abc123abc123"] });
  assert.equal((await t.call("POST", `/posts/${m.id}/submit`, { actor: alice })).status, 422);
  await t.close();
});

test("staff routes: missing, wrong and unconfigured token are all refused", async () => {
  const t = await setup();
  const routes = [["GET", "/posts"], ["GET", "/posts/1"], ["POST", "/posts", { platform: "gbp", kind: "update", content: GOOD, actor: alice }], ["POST", "/posts/1/approve", { actor: bob }], ["POST", "/posts/1/publish", { actor: bob }], ["POST", "/connections", { platform: "gbp", scope: ["post"], actor: alice }], ["POST", "/connections/gbp/revoke", { actor: alice }], ["GET", "/connections"], ["POST", "/reviews", { source: "google", rating: 5, body: "x" }]];
  for (const [m, u, p] of routes) {
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "Basic abc" }]) {
      assert.equal((await t.call(m, u, p, headers)).status, 401, `${m} ${u} ${JSON.stringify(headers)}`);
    }
  }
  assert.equal((await t.db.query("SELECT count(*)::int n FROM social_posts")).rows[0].n, 0);
  await t.close();
  const off = await setup({ staffToken: null });
  assert.equal((await off.call("GET", "/posts", undefined, auth)).status, 503);
  await off.close();
});

test("input validation: malformed bodies and ids are refused cleanly", async () => {
  const t = await setup();
  const base = { platform: "gbp", kind: "update", content: GOOD, actor: alice };
  for (const bad of [{ platform: "tiktok" }, { kind: "ad" }, { content: "" }, { content: "x".repeat(5001) }, { media: Array(11).fill("https://example.org/a.jpg") }, { actor: undefined }, { sourceReviewId: 0 }]) {
    assert.equal((await t.call("POST", "/posts", { ...base, ...bad })).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await t.call("POST", "/posts", { ...base, sourceReviewId: 999 })).status, 422, "unknown review id");
  assert.equal((await t.call("GET", "/posts/abc")).status, 400);
  assert.equal((await t.call("GET", "/posts/99999")).status, 404);
  assert.equal((await t.call("POST", "/posts/99999/approve", { actor: bob })).status, 404);
  assert.equal((await t.call("PATCH", "/posts/99999", { actor: bob, content: "x" })).status, 404);
  const d = await t.draft();
  assert.equal((await t.call("PATCH", `/posts/${d.id}`, { actor: bob })).status, 400, "empty edit");
  await t.close();
});
