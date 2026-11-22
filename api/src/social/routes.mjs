// Staff-only social publishing routes under /api/staff/social. Auth is the shared staff guard (onRequest hook).
// Actors are supplied in the request body, like the lead-transition route; per-user auth is an open owner item.
import { PLATFORMS, KINDS, REVIEW_SOURCES } from "./policy.mjs";
import {
  ACTOR_TYPES, ContentPolicyError, createPost, editPost, submitPost, approvePost, rejectPost, publishPost, getPost, listPosts, listEvents,
  grantConnection, revokeConnection, listConnections, recordManualReview, getReview,
} from "./service.mjs";

export { checkPostContent, wrapUntrusted } from "./policy.mjs";
export { notConfiguredPublisher, fakePublisher, PublisherNotConfiguredError } from "./publishers.mjs";
export { recordOfficialReview, recordManualReview, contentHash, TRANSITIONS } from "./service.mjs";

const idParams = { type: "object", properties: { id: { type: "string", pattern: "^[0-9]{1,18}$" } }, required: ["id"] };
const platformParams = { type: "object", properties: { platform: { enum: PLATFORMS } }, required: ["platform"] };
const actor = {
  type: "object", additionalProperties: false, required: ["type", "id"],
  properties: { type: { enum: ACTOR_TYPES }, id: { type: "string", pattern: "^[A-Za-z0-9._:@-]{1,64}$" } },
};
const content = { type: "string", minLength: 1, maxLength: 5000 };
const media = { type: "array", maxItems: 10, items: { type: "string", maxLength: 2000 } };
const reviewId = { type: ["integer", "null"], minimum: 1, maximum: 9007199254740991 };
const actorOnly = { type: "object", additionalProperties: false, properties: { actor } };

export async function registerSocialRoutes(app, { db, now = () => new Date(), catalog, publishers = {}, staffAuth, staffGuard, publishTimeoutMs }) {
  // staffAuth (preferred) supplies the guard, the acting identity and role gates; a bare staffGuard keeps the legacy body-actor behavior.
  const guard = staffAuth?.guard ?? staffGuard;
  if (typeof guard !== "function") throw new Error("registerSocialRoutes needs a staffAuth or staffGuard");
  const who = (req) => (staffAuth ? staffAuth.actor(req, req.body?.actor) : req.body.actor);
  const approvers = staffAuth ? { onRequest: [staffAuth.requireRole("approver", "admin")] } : {};
  const deps = { catalog, publishers, now, publishTimeoutMs };
  const at = () => ({ catalog, now: now() });

  // A content-policy refusal carries its violation list; everything else goes to the server's shared error handler.
  const guarded = (fn) => async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof ContentPolicyError) return reply.code(422).send({ error: e.code, message: e.message, violations: e.violations });
      throw e;
    }
  };

  await app.register(async (s) => {
    s.addHook("onRequest", guard);

    // ---- consent (S4) ----
    s.get("/connections", async () => ({ connections: await listConnections(db) }));
    s.post("/connections", {
      ...approvers,
      schema: {
        body: {
          type: "object", additionalProperties: false, required: ["platform", "scope"],
          properties: { platform: { enum: PLATFORMS }, scope: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", pattern: "^[a-zA-Z0-9_.:/-]{1,80}$" } }, wordingVersion: { type: "string", maxLength: 32 }, actor },
        },
      },
    }, async (req, reply) => reply.code(201).send({ connection: await grantConnection(db, req.body, who(req), { now: now() }) }));
    s.post("/connections/:platform/revoke", { ...approvers, schema: { params: platformParams, body: actorOnly } }, async (req) =>
      ({ connection: await revokeConnection(db, req.params.platform, who(req), { now: now() }) }));

    // ---- reviews: staff can record one by hand; it can never be used as a testimonial source ----
    s.post("/reviews", {
      schema: {
        body: {
          type: "object", additionalProperties: false, required: ["source", "rating", "body"],
          properties: { source: { enum: REVIEW_SOURCES }, rating: { type: "integer", minimum: 1, maximum: 5 }, body: { type: "string", minLength: 1, maxLength: 4000 }, authorDisplay: { type: "string", maxLength: 120 }, sourceUrl: { type: "string", maxLength: 2000 } },
        },
      },
    }, async (req, reply) => reply.code(201).send({ review: await recordManualReview(db, req.body, { now: now() }) }));
    s.get("/reviews/:id", { schema: { params: idParams } }, async (req) => ({ review: await getReview(db, req.params.id) }));

    // ---- posts ----
    s.post("/posts", {
      schema: {
        body: {
          type: "object", additionalProperties: false, required: ["platform", "kind", "content"],
          properties: { platform: { enum: PLATFORMS }, kind: { enum: KINDS }, content, media, sourceReviewId: reviewId, actor },
        },
      },
    }, guarded(async (req, reply) => reply.code(201).send(await createPost(db, req.body, who(req), at()))));

    s.get("/posts", {
      schema: { querystring: { type: "object", properties: { status: { enum: ["draft", "pending_approval", "approved", "published", "failed", "rejected"] }, platform: { enum: PLATFORMS }, limit: { type: "integer", minimum: 1, maximum: 100 } } } },
    }, async (req) => ({ posts: await listPosts(db, req.query) }));
    s.get("/posts/:id", { schema: { params: idParams } }, async (req) => getPost(db, req.params.id, { catalog }));
    s.get("/posts/:id/events", { schema: { params: idParams } }, async (req) => ({ events: await listEvents(db, req.params.id) }));

    s.patch("/posts/:id", {
      schema: { params: idParams, body: { type: "object", additionalProperties: false, properties: { content, media, sourceReviewId: reviewId, actor } } },
    }, guarded(async (req) => editPost(db, req.params.id, req.body, who(req), at())));

    s.post("/posts/:id/submit", { schema: { params: idParams, body: actorOnly } }, guarded(async (req) => ({ post: await submitPost(db, req.params.id, who(req), at()) })));
    s.post("/posts/:id/approve", { ...approvers, schema: { params: idParams, body: actorOnly } }, guarded(async (req) => ({ post: await approvePost(db, req.params.id, who(req), at()) })));
    s.post("/posts/:id/reject", {
      ...approvers,
      schema: { params: idParams, body: { type: "object", additionalProperties: false, properties: { actor, reason: { type: "string", maxLength: 500 } } } },
    }, async (req) => ({ post: await rejectPost(db, req.params.id, who(req), req.body.reason, { now: now() }) }));

    s.post("/posts/:id/publish", { ...approvers, schema: { params: idParams, body: actorOnly } }, guarded(async (req, reply) => {
      const r = await publishPost(db, deps, req.params.id, who(req));
      // The platform's id clashes with another post's: a conflict to resolve by hand, not a platform outage.
      if (r.failed && r.kind === "duplicate_external_id") return reply.code(409).send({ error: "duplicate_external_id", message: r.post.error, post: r.post });
      if (r.failed) return reply.code(502).send({ error: "publish_failed", message: "The platform refused or did not confirm the post; it will not be retried automatically", post: r.post });
      return r.alreadyPublished ? { post: r.post, alreadyPublished: true } : { post: r.post };
    }));
  }, { prefix: "/api/staff/social" });
}
