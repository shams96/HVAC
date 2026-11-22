import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, alice, bob, GOOD, PLATFORMS } from "./social-helpers.mjs";
import { buildPublishers, configuredPlatforms, ADAPTERS } from "../src/social/registry.mjs";
import { fakePublisher, notConfiguredPublisher } from "../src/social/publishers.mjs";
import { assembleDeps } from "../src/assemble.mjs";
import { loadConfig } from "../src/config.mjs";
import { emptyCatalog } from "../src/catalog.mjs";
import { fixtureCatalog } from "./catalog-fixture.mjs";

const base = { DATABASE_URL: "postgres://x", STAFF_API_TOKEN: "t".repeat(40) };

test("registry: every platform refuses until an adapter is registered; a registered adapter is used", () => {
  const none = buildPublishers({});
  assert.deepEqual(Object.keys(none).sort(), [...PLATFORMS].sort());
  assert.ok(PLATFORMS.every((p) => none[p] === notConfiguredPublisher));
  assert.deepEqual(configuredPlatforms(none), []);
  assert.deepEqual(Object.keys(ADAPTERS), [], "no real adapters exist yet (stated honestly)");

  const gbp = fakePublisher();
  const some = buildPublishers({ X: "1" }, { gbp: (env) => (env.X ? gbp : null), youtube: () => ({ not: "a publisher" }) });
  assert.equal(some.gbp, gbp);
  assert.equal(some.youtube, notConfiguredPublisher, "a malformed adapter is rejected, not trusted");
  assert.deepEqual(configuredPlatforms(some), ["gbp"]);
});

test("through the wired server, with no adapter: the whole approval flow works and publishing is refused with 503, leaving the post approved", async () => {
  const s = await setup({ publishers: buildPublishers({}) });
  await s.connect("gbp");
  const post = await s.approved();
  assert.equal(await s.status(post.id), "approved");
  const r = await s.call("POST", `/posts/${post.id}/publish`, { actor: alice });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "publisher_not_configured");
  assert.equal(await s.status(post.id), "approved", "not burned: it can be published once an adapter exists");
  const attempted = (await s.db.query("SELECT publish_attempted_at FROM social_posts WHERE id = $1", [post.id])).rows[0].publish_attempted_at;
  assert.equal(attempted, null);
  await s.close();
});

test("through the wired server, with a registered adapter: publishes exactly once, after human approval and consent", async () => {
  const gbp = fakePublisher();
  const s = await setup({ publishers: buildPublishers({}, { gbp: () => gbp }) });
  const unapproved = await s.pending();
  assert.equal((await s.call("POST", `/posts/${unapproved.id}/publish`, { actor: alice })).status >= 400, true, "cannot publish unapproved");
  await s.connect("gbp");
  const post = await s.approved();
  const r1 = await s.call("POST", `/posts/${post.id}/publish`, { actor: alice });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.equal((await s.call("POST", `/posts/${post.id}/publish`, { actor: alice })).json.alreadyPublished, true);
  assert.equal(gbp.calls.length, 1, "one post on the platform");
  assert.equal(gbp.calls[0].content, GOOD);
  await s.close();
});

test("staff social routes: token required, and browsers cannot send the token cross-origin", async () => {
  const s = await setup({ publishers: buildPublishers({}) });
  const noAuth = await s.call("GET", "/posts", undefined, {});
  assert.equal(noAuth.status, 401);
  const wrong = await s.call("GET", "/posts", undefined, { authorization: "Bearer nope" });
  assert.equal(wrong.status, 401);
  assert.equal((await s.call("GET", "/posts")).status, 200);
  await s.close();
});

test("assembly: modules start only when configured", () => {
  const off = assembleDeps(loadConfig(base), { catalog: emptyCatalog() });
  assert.equal(off.agentDeps, null);
  assert.equal(off.socialDeps, null);
  assert.match(off.notes.join("\n"), /chat agent disabled/);
  assert.match(off.notes.join("\n"), /social publishing disabled/);

  const on = assembleDeps(loadConfig({ ...base, SOCIAL_ENABLED: "1" }), { catalog: fixtureCatalog() });
  assert.equal(on.agentDeps, null);
  assert.ok(on.socialDeps.publishers.gbp, "all four platforms are present");
  assert.deepEqual(Object.keys(on.socialDeps.publishers).sort(), [...PLATFORMS].sort());
  assert.match(on.notes.join("\n"), /none, every publish will be refused with 503/);
  assert.ok(on.warnings.some((w) => /shared staff token/.test(w)), "the identity limitation is logged at startup");

  const empty = assembleDeps(loadConfig({ ...base, SOCIAL_ENABLED: "1" }), { catalog: emptyCatalog() });
  assert.ok(empty.warnings.some((w) => /catalog is empty/.test(w)));

  const both = assembleDeps(loadConfig({ ...base, SOCIAL_ENABLED: "1", LLM_PROVIDER: "ollama", OLLAMA_MODEL: "m" }), { catalog: fixtureCatalog(), makeLlm: () => ({ complete: async () => ({}) }) });
  assert.ok(both.agentDeps && both.socialDeps);
  assert.equal(both.agentDeps.catalog, both.socialDeps.catalog, "one catalog for both modules");
});

test("config: only the exact value 1 enables social", () => {
  assert.equal(loadConfig(base).social, false);
  assert.equal(loadConfig({ ...base, SOCIAL_ENABLED: "1" }).social, true);
  for (const v of ["true", "yes", "0", "", " 1"]) assert.equal(loadConfig({ ...base, SOCIAL_ENABLED: v }).social, false, JSON.stringify(v));
});
