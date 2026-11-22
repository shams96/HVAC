// Social publishing domain logic (Contract B, S1-S7). Every state change runs in one transaction and is audited.
import { createHash } from "node:crypto";
import { PipelineError } from "../repo/leads.mjs";
import { PLATFORMS, KINDS, REVIEW_SOURCES, checkPostContent, sourceUrlOk, redactSecrets, hasSecret, cleanPostText } from "./policy.mjs";

export const ACTOR_TYPES = ["user", "agent", "system", "webhook"];
export const ACTOR_ID = /^[A-Za-z0-9._:@-]{1,64}$/;

// S1: the only legal moves. Anything else is refused.
export const TRANSITIONS = {
  draft: ["pending_approval"],
  pending_approval: ["approved", "rejected", "draft"],
  approved: ["published", "failed", "draft", "rejected"],
  rejected: ["draft"],
  published: [],
  failed: [],
};

export class ContentPolicyError extends PipelineError {
  constructor(violations) {
    super("content_policy", `Post violates content policy: ${violations.map((x) => x.code).join(", ")}`, 422);
    this.violations = violations;
  }
}

const iso = (d) => d.toISOString();
const sameActor = (a, b) => String(a).normalize("NFKC").trim().toLowerCase() === String(b).normalize("NFKC").trim().toLowerCase();
const cut = (s, n = 500) => String(s ?? "").slice(0, n);

function assertActor(actor) {
  if (!ACTOR_TYPES.includes(actor?.type) || typeof actor?.id !== "string" || !ACTOR_ID.test(actor.id)) {
    throw new PipelineError("actor_required", "A valid actor type and id are required");
  }
}
function assertTransition(from, to) {
  if (!(TRANSITIONS[from] ?? []).includes(to)) throw new PipelineError("illegal_transition", `A ${from} post cannot become ${to}`, 409);
}
const parseId = (id) => {
  if (!/^[0-9]{1,18}$/.test(String(id))) throw new PipelineError("not_found", "Not found", 404);
  return String(id);
};

// S3: hash of exactly what will be posted. Any change to platform, kind, text, media or the linked review changes it.
export function contentHash({ platform, kind, content, media, sourceReviewId }) {
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, platform, kind, content, media: media ?? [], sourceReviewId: sourceReviewId == null ? null : String(sourceReviewId) }))
    .digest("hex");
}

const toPost = (r) =>
  r && {
    id: Number(r.id),
    platform: r.platform,
    kind: r.kind,
    content: r.content,
    media: r.media ?? [],
    sourceReviewId: r.source_review_id == null ? null : Number(r.source_review_id),
    status: r.status,
    createdBy: { type: r.created_by_type, id: r.created_by_id },
    lastEditedBy: { type: r.last_edited_by_type, id: r.last_edited_by_id },
    approvedBy: r.approved_by_id ? { type: r.approved_by_type, id: r.approved_by_id } : null,
    approvedAt: r.approved_at ?? null,
    contentHash: r.content_hash ?? null,
    rejectReason: r.reject_reason ?? null,
    publishAttemptedAt: r.publish_attempted_at ?? null,
    publishedAt: r.published_at ?? null,
    externalId: r.external_id ?? null,
    error: r.error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
const toReview = (r) =>
  r && {
    id: Number(r.id), source: r.source, externalId: r.external_id, rating: Number(r.rating), body: r.body, authorDisplay: r.author_display,
    sourceUrl: r.source_url, capturedVia: r.captured_via, capturedAt: r.captured_at,
  };
const toConnection = (r) =>
  r && {
    id: Number(r.id), platform: r.platform, status: r.status, scope: r.scope, consentedBy: { type: r.consented_by_type, id: r.consented_by_id },
    consentedAt: r.consented_at, wordingVersion: r.wording_version,
    revokedBy: r.revoked_at ? { type: r.revoked_by_type, id: r.revoked_by_id } : null, revokedAt: r.revoked_at ?? null,
  };

async function addEvent(q, postId, nowIso, actor, type, from, to, data = {}) {
  await q.query(
    `INSERT INTO social_post_events (post_id, at, actor_type, actor_id, event_type, from_status, to_status, data)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8::jsonb)`,
    [postId, nowIso, actor.type, actor.id, type, from, to, JSON.stringify(data)]
  );
}
const lockPost = async (tx, id) => {
  const r = (await tx.query("SELECT * FROM social_posts WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!r) throw new PipelineError("not_found", "Post not found", 404);
  return r;
};
const loadReview = async (q, id) => (id == null ? null : toReview((await q.query("SELECT * FROM reviews WHERE id = $1", [id])).rows[0]));
// Consent only authorises posting when its recorded scope includes a posting permission ("post", "publish", "write", ...);
// a read-only grant (insights.read, reviews.read) is consent to read, not to publish.
const POSTING_SCOPE = /(?:^|[._:/-])(?:posts?|publish|write|create|upload|manage|content)(?:$|[._:/-])|pages_manage_posts|content_publish/i;
const scopeAllowsPosting = (scope) => Array.isArray(scope) && scope.some((x) => typeof x === "string" && POSTING_SCOPE.test(x));
const activeConnection = async (q, platform) => {
  const row = (await q.query("SELECT * FROM social_connections WHERE platform = $1 AND status = 'granted'", [platform])).rows[0] ?? null;
  return row && scopeAllowsPosting(row.scope) ? row : null;
};
// What a platform error echoes back may include the post text (and so personal data): that text is cut out.
function scrubEcho(message, content) {
  const msg = String(message ?? "");
  const c = String(content ?? "");
  const W = 16;
  if (c.length < W) return msg;
  const hide = new Array(msg.length).fill(false);
  for (let i = 0; i + W <= msg.length; i++) if (c.includes(msg.slice(i, i + W))) for (let k = i; k < i + W; k++) hide[k] = true;
  let out = "";
  let inside = false;
  for (let i = 0; i < msg.length; i++) {
    if (hide[i]) {
      if (!inside) { out += "[post text]"; inside = true; }
    } else {
      out += msg[i];
      inside = false;
    }
  }
  return out;
}

async function evaluate(q, row, catalog) {
  const post = toPost(row);
  const review = await loadReview(q, post.sourceReviewId);
  return { post, review, violations: checkPostContent(post, catalog, { review }) };
}
// Refusals are recorded as events, so a refused action returns an error object (the transaction still commits) and is thrown afterwards.
const refuse = (err) => ({ err });
const unwrap = (r) => {
  if (r?.err) throw r.err;
  return r;
};

// ---------- reviews ----------
function validateReview(r) {
  if (!REVIEW_SOURCES.includes(r?.source)) throw new PipelineError("invalid_review", "Unknown review source");
  if (!Number.isInteger(r.rating) || r.rating < 1 || r.rating > 5) throw new PipelineError("invalid_review", "Rating must be 1 to 5");
  if (typeof r.body !== "string" || !r.body.trim() || r.body.length > 4000) throw new PipelineError("invalid_review", "Review text is required (max 4000 chars)");
}

// Internal ingestion path for a real platform adapter. NOT exposed over HTTP: only code that fetched the review from an
// official API may call it, which is what makes a review quotable as a testimonial.
export async function recordOfficialReview(db, r, { now = new Date() } = {}) {
  validateReview(r);
  if (!r.externalId || !r.sourceUrl || !sourceUrlOk(r.source, r.sourceUrl)) throw new PipelineError("invalid_review", "Official reviews need an external id and a source URL on the issuing platform");
  return insertReview(db, r, "official_api", now);
}
// Staff may record a review by hand. It can be replied to, but never shared as a testimonial.
export async function recordManualReview(db, r, { now = new Date() } = {}) {
  validateReview(r);
  if (r.sourceUrl != null && !sourceUrlOk(r.source, r.sourceUrl)) throw new PipelineError("invalid_review", "Source URL must be https on the issuing platform");
  return insertReview(db, { ...r, externalId: null }, "manual", now);
}
async function insertReview(db, r, via, now) {
  const res = await db.query(
    `INSERT INTO reviews (source, external_id, rating, body, author_display, source_url, captured_via, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz) RETURNING *`,
    [r.source, r.externalId ?? null, r.rating, cleanPostText(r.body), r.authorDisplay == null ? null : cleanPostText(r.authorDisplay), r.sourceUrl ?? null, via, iso(now)]
  );
  return toReview(res.rows[0]);
}
export async function getReview(db, id) {
  const r = await loadReview(db, parseId(id));
  if (!r) throw new PipelineError("not_found", "Review not found", 404);
  return r;
}

// ---------- connections (S4) ----------
export async function grantConnection(db, { platform, scope, wordingVersion }, actor, { now = new Date() } = {}) {
  assertActor(actor);
  if (actor.type !== "user") throw new PipelineError("human_consent_required", "Only a person can grant publishing consent", 403);
  if (!PLATFORMS.includes(platform)) throw new PipelineError("invalid_platform", "Unknown platform");
  if (!Array.isArray(scope) || !scope.length || scope.length > 20 || !scope.every((s) => typeof s === "string" && /^[a-z0-9_.:/-]{1,80}$/i.test(s) && !hasSecret(s))) {
    throw new PipelineError("invalid_scope", "Scope must be 1 to 20 short permission names");
  }
  try {
    const r = await db.query(
      `INSERT INTO social_connections (platform, status, scope, consented_by_type, consented_by_id, consented_at, wording_version)
       VALUES ($1, 'granted', $2::jsonb, 'user', $3, $4::timestamptz, $5) RETURNING *`,
      [platform, JSON.stringify(scope), actor.id, iso(now), wordingVersion ?? null]
    );
    return toConnection(r.rows[0]);
  } catch (e) {
    if (e?.code === "23505" || /social_connections_one_active_uq/.test(String(e?.message))) throw new PipelineError("already_connected", `${platform} already has active consent`, 409);
    throw e;
  }
}
export async function revokeConnection(db, platform, actor, { now = new Date() } = {}) {
  assertActor(actor);
  if (!PLATFORMS.includes(platform)) throw new PipelineError("invalid_platform", "Unknown platform");
  const r = await db.query(
    `UPDATE social_connections SET status = 'revoked', revoked_by_type = $2, revoked_by_id = $3, revoked_at = $4::timestamptz
     WHERE platform = $1 AND status = 'granted' RETURNING *`,
    [platform, actor.type, actor.id, iso(now)]
  );
  if (!r.rows[0]) throw new PipelineError("no_active_connection", `${platform} has no active consent`, 404);
  return toConnection(r.rows[0]);
}
export async function listConnections(db) {
  return (await db.query("SELECT * FROM social_connections ORDER BY id")).rows.map(toConnection);
}

// ---------- posts ----------
const cleanField = (v) => (typeof v === "string" ? cleanPostText(v) : v);
const cleanMedia = (m) => (Array.isArray(m) ? m.map(cleanField) : m);
function validateDraft({ platform, kind, content, media, sourceReviewId }) {
  if (sourceReviewId != null && !(Number.isSafeInteger(Number(sourceReviewId)) && Number(sourceReviewId) >= 1)) throw new PipelineError("invalid_post", "Invalid review id");
  if (!PLATFORMS.includes(platform)) throw new PipelineError("invalid_post", "Unknown platform");
  if (!KINDS.includes(kind)) throw new PipelineError("invalid_post", "Unknown post kind");
  if (typeof content !== "string" || !content.trim() || content.length > 5000) throw new PipelineError("invalid_post", "Post text is required (max 5000 chars)");
  if (!Array.isArray(media) || media.length > 10 || !media.every((m) => typeof m === "string" && m.length <= 2000)) throw new PipelineError("invalid_post", "Media must be a list of at most 10 URLs");
}
async function assertReviewExists(q, id) {
  if (id != null && !(await q.query("SELECT 1 FROM reviews WHERE id = $1", [id])).rows.length) throw new PipelineError("review_not_found", "The referenced review does not exist", 422);
}

export async function createPost(db, input, actor, { catalog, now = new Date() } = {}) {
  assertActor(actor);
  const d = { platform: input?.platform, kind: input?.kind, content: cleanField(input?.content), media: cleanMedia(input?.media ?? []), sourceReviewId: input?.sourceReviewId ?? null };
  validateDraft(d);
  const nowIso = iso(now);
  return db.transaction(async (tx) => {
    await assertReviewExists(tx, d.sourceReviewId);
    const row = (
      await tx.query(
        `INSERT INTO social_posts (platform, kind, content, media, source_review_id, status, created_by_type, created_by_id,
                                   last_edited_by_type, last_edited_by_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, 'draft', $6, $7, $6, $7, $8::timestamptz, $8::timestamptz) RETURNING *`,
        [d.platform, d.kind, d.content, JSON.stringify(d.media), d.sourceReviewId, actor.type, actor.id, nowIso]
      )
    ).rows[0];
    await addEvent(tx, row.id, nowIso, actor, "created", null, "draft", { platform: d.platform, kind: d.kind });
    const { post, violations } = await evaluate(tx, row, catalog);
    return { post, violations };
  });
}

// S3: editing never keeps an approval. An approved post goes back to draft with approval and hash cleared.
export async function editPost(db, id, patch, actor, { catalog, now = new Date() } = {}) {
  assertActor(actor);
  id = parseId(id);
  const fields = ["content", "media", "sourceReviewId"].filter((f) => patch && f in patch);
  if (!fields.length) throw new PipelineError("nothing_to_change", "Provide content, media or sourceReviewId");
  const nowIso = iso(now);
  return db.transaction(async (tx) => {
    const cur = await lockPost(tx, id);
    if (cur.status === "published" || cur.status === "failed") throw new PipelineError("post_closed", `A ${cur.status} post cannot be edited`, 409);
    if (cur.publish_attempted_at) throw new PipelineError("publish_in_progress", "This post is being published", 409);
    const next = {
      platform: cur.platform, kind: cur.kind,
      content: "content" in patch ? cleanField(patch.content) : cur.content,
      media: "media" in patch ? cleanMedia(patch.media ?? []) : cur.media,
      sourceReviewId: "sourceReviewId" in patch ? patch.sourceReviewId ?? null : cur.source_review_id,
    };
    validateDraft(next);
    await assertReviewExists(tx, next.sourceReviewId);
    if (cur.status !== "draft") assertTransition(cur.status, "draft");
    const row = (
      await tx.query(
        `UPDATE social_posts SET content = $2, media = $3::jsonb, source_review_id = $4, status = 'draft',
                approved_by_type = NULL, approved_by_id = NULL, approved_at = NULL, content_hash = NULL, reject_reason = NULL,
                last_edited_by_type = $5, last_edited_by_id = $6, updated_at = $7::timestamptz
         WHERE id = $1 RETURNING *`,
        [id, next.content, JSON.stringify(next.media), next.sourceReviewId, actor.type, actor.id, nowIso]
      )
    ).rows[0];
    await addEvent(tx, id, nowIso, actor, "edited", cur.status, "draft", { fields, approval_cleared: cur.status === "approved" });
    const { post, violations } = await evaluate(tx, row, catalog);
    return { post, violations };
  });
}

export async function submitPost(db, id, actor, { catalog, now = new Date() } = {}) {
  assertActor(actor);
  id = parseId(id);
  const nowIso = iso(now);
  const r = await db.transaction(async (tx) => {
    const cur = await lockPost(tx, id);
    assertTransition(cur.status, "pending_approval");
    const { violations } = await evaluate(tx, cur, catalog);
    if (violations.length) {
      await addEvent(tx, id, nowIso, actor, "submit_refused", cur.status, cur.status, { violations: violations.map((x) => x.code) });
      return refuse(new ContentPolicyError(violations));
    }
    const row = (await tx.query("UPDATE social_posts SET status = 'pending_approval', updated_at = $2::timestamptz WHERE id = $1 RETURNING *", [id, nowIso])).rows[0];
    await addEvent(tx, id, nowIso, actor, "submitted", cur.status, "pending_approval");
    return { post: toPost(row) };
  });
  return unwrap(r).post;
}

// S2: approver must be a person, not the creator and not the last editor. Content is re-checked at approval (S5).
export async function approvePost(db, id, actor, { catalog, now = new Date() } = {}) {
  assertActor(actor);
  id = parseId(id);
  const nowIso = iso(now);
  const r = await db.transaction(async (tx) => {
    const cur = await lockPost(tx, id);
    assertTransition(cur.status, "approved");
    const deny = async (code, message, status = 403) => {
      await addEvent(tx, id, nowIso, actor, "approval_refused", cur.status, cur.status, { reason: code });
      return refuse(new PipelineError(code, message, status));
    };
    if (actor.type !== "user") return deny("human_approval_required", "Only a person can approve a post");
    if (sameActor(actor.id, cur.created_by_id)) return deny("self_approval_forbidden", "The creator cannot approve their own post");
    if (sameActor(actor.id, cur.last_edited_by_id)) return deny("editor_approval_forbidden", "The last editor cannot approve the post");
    const { post, violations } = await evaluate(tx, cur, catalog);
    if (violations.length) {
      await addEvent(tx, id, nowIso, actor, "approval_refused", cur.status, cur.status, { reason: "content_policy", violations: violations.map((x) => x.code) });
      return refuse(new ContentPolicyError(violations));
    }
    const hash = contentHash(post);
    const row = (
      await tx.query(
        `UPDATE social_posts SET status = 'approved', approved_by_type = 'user', approved_by_id = $2, approved_at = $3::timestamptz,
                content_hash = $4, updated_at = $3::timestamptz WHERE id = $1 RETURNING *`,
        [id, actor.id, nowIso, hash]
      )
    ).rows[0];
    await addEvent(tx, id, nowIso, actor, "approved", cur.status, "approved", { content_hash: hash });
    return { post: toPost(row) };
  });
  return unwrap(r).post;
}

export async function rejectPost(db, id, actor, reason, { now = new Date() } = {}) {
  assertActor(actor);
  id = parseId(id);
  if (actor.type !== "user") throw new PipelineError("human_review_required", "Only a person can reject a post", 403);
  const nowIso = iso(now);
  return db.transaction(async (tx) => {
    const cur = await lockPost(tx, id);
    assertTransition(cur.status, "rejected");
    if (cur.publish_attempted_at) throw new PipelineError("publish_in_progress", "This post is being published", 409);
    const row = (
      await tx.query(
        `UPDATE social_posts SET status = 'rejected', approved_by_type = NULL, approved_by_id = NULL, approved_at = NULL, content_hash = NULL,
                reject_reason = $2, updated_at = $3::timestamptz WHERE id = $1 RETURNING *`,
        [id, reason ? cut(cleanPostText(reason)) : null, nowIso]
      )
    ).rows[0];
    await addEvent(tx, id, nowIso, actor, "rejected", cur.status, "rejected", { reason_recorded: Boolean(reason) });
    return toPost(row);
  });
}

// S1, S3, S4, S6: publish only an approved, unchanged, consented post, at most once, never retried automatically.
// deps: { catalog, publishers, now() -> Date, publishTimeoutMs? }
export async function publishPost(db, deps, id, actor) {
  assertActor(actor);
  id = parseId(id);
  const { catalog, publishers = {}, publishTimeoutMs = 30_000 } = deps;
  const clock = deps.now ?? (() => new Date());

  const claim = await db.transaction(async (tx) => {
    const nowIso = iso(clock());
    const cur = await lockPost(tx, id);
    if (cur.status === "published") return { already: toPost(cur) }; // S6: second publish is a no-op
    const deny = async (code, message, status) => {
      await addEvent(tx, id, nowIso, actor, "publish_refused", cur.status, cur.status, { reason: code });
      return refuse(new PipelineError(code, message, status));
    };
    if (cur.status !== "approved") return deny("not_approved", `Only an approved post can be published (this one is ${cur.status})`, 409);
    if (cur.publish_attempted_at) return deny("publish_already_attempted", "A publish was already attempted for this post; it will not be retried automatically", 409);
    if (cur.approved_by_type !== "user" || !cur.approved_by_id || sameActor(cur.approved_by_id, cur.created_by_id)) return deny("approval_invalid", "The approval on record is not a valid human approval", 403);
    const { post, violations } = await evaluate(tx, cur, catalog);
    if (!cur.content_hash || contentHash(post) !== cur.content_hash) return deny("content_changed_after_approval", "The post no longer matches what was approved", 409);
    if (violations.length) {
      await addEvent(tx, id, nowIso, actor, "publish_refused", cur.status, cur.status, { reason: "content_policy", violations: violations.map((x) => x.code) });
      return refuse(new ContentPolicyError(violations));
    }
    if (!(await activeConnection(tx, post.platform))) return deny("no_consent", `There is no active consent to publish to ${post.platform}`, 403);
    const pub = publishers[post.platform];
    if (!pub || pub.configured === false || typeof pub.publish !== "function") return deny("publisher_not_configured", `No publisher is configured for ${post.platform}`, 503);
    const upd = await tx.query(
      `UPDATE social_posts SET publish_attempted_at = $2::timestamptz, updated_at = $2::timestamptz
       WHERE id = $1 AND status = 'approved' AND publish_attempted_at IS NULL AND content_hash = $3`,
      [id, nowIso, cur.content_hash]
    );
    if (!(upd.affectedRows ?? upd.rowCount ?? 1)) return deny("publish_already_attempted", "Another publish is in progress", 409);
    await addEvent(tx, id, nowIso, actor, "publish_started", "approved", "approved", { content_hash: cur.content_hash });
    return { post, pub };
  });
  if (claim.already) return { post: claim.already, alreadyPublished: true };
  unwrap(claim);
  const { post, pub } = claim;

  // Consent may have been revoked while we were claiming. Nothing was sent yet, so release the claim and stop.
  if (!(await activeConnection(db, post.platform))) {
    const nowIso = iso(clock());
    await db.transaction(async (tx) => {
      await tx.query("UPDATE social_posts SET publish_attempted_at = NULL, updated_at = $2::timestamptz WHERE id = $1 AND status = 'approved'", [id, nowIso]);
      await addEvent(tx, id, nowIso, actor, "publish_refused", "approved", "approved", { reason: "no_consent" });
    });
    throw new PipelineError("no_consent", `There is no active consent to publish to ${post.platform}`, 403);
  }

  let result;
  let failure = null;
  let failureKind = "publisher_error";
  let timer;
  try {
    const call = pub.publish({
      id: post.id, platform: post.platform, kind: post.kind, content: cleanPostText(post.content), media: post.media.map(cleanPostText),
      idempotencyKey: `social-post-${post.id}-${post.contentHash ?? contentHash(post)}`.slice(0, 120),
    });
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("Publish timed out; verify on the platform before creating a new post")), publishTimeoutMs); });
    result = await Promise.race([call, timeout]);
    if (!result || typeof result.externalId !== "string" || !result.externalId.trim() || result.externalId.length > 200) {
      failure = "Publisher returned no usable externalId; verify on the platform before creating a new post";
      failureKind = "no_external_id";
    }
  } catch (e) {
    failure = cut(scrubEcho(redactSecrets(e?.message ?? "publish failed"), post.content));
  } finally {
    clearTimeout(timer);
  }

  const doneIso = iso(clock());
  // The audit event records a failure class only: platform error text can echo post text or credentials, and events are append-only.
  const markFailed = async (tx, kind, message) => {
    const row = (
      await tx.query(
        `UPDATE social_posts SET status = 'failed', error = $2, updated_at = $3::timestamptz
         WHERE id = $1 AND status = 'approved' AND publish_attempted_at IS NOT NULL RETURNING *`,
        [id, message, doneIso]
      )
    ).rows[0];
    await addEvent(tx, id, doneIso, actor, "publish_failed", "approved", "failed", { failure: kind });
    return { post: toPost(row), failed: true, kind };
  };
  const dupMessage = "The platform returned an id that already belongs to another post; verify on the platform before creating a new post";
  const settle = () => db.transaction(async (tx) => {
    if (failure) return markFailed(tx, failureKind, failure);
    // A platform may hand back an id that already belongs to another post. The post went out, but it cannot be recorded
    // under that id, so it is closed as failed with a clear message instead of staying approved with a burned attempt.
    const dup = await tx.query("SELECT 1 FROM social_posts WHERE platform = $1 AND external_id = $2 AND id <> $3", [post.platform, result.externalId.trim(), id]);
    if (dup.rows.length) return markFailed(tx, "duplicate_external_id", dupMessage);
    const row = (
      await tx.query(
        `UPDATE social_posts SET status = 'published', external_id = $2, published_at = $3::timestamptz, error = NULL, updated_at = $3::timestamptz
         WHERE id = $1 AND status = 'approved' AND publish_attempted_at IS NOT NULL RETURNING *`,
        [id, result.externalId.trim(), doneIso]
      )
    ).rows[0];
    await addEvent(tx, id, doneIso, actor, "published", "approved", "published", { external_id: result.externalId.trim() });
    return { post: toPost(row), failed: false };
  });
  try {
    return await settle();
  } catch (e) {
    // Two posts finishing at once with the same platform id: the unique index refused the second, so close it as failed.
    if (e?.code === "23505" || /social_posts_external_uq/.test(String(e?.message))) {
      failure = dupMessage;
      failureKind = "duplicate_external_id";
      return db.transaction((tx) => markFailed(tx, failureKind, failure));
    }
    throw e;
  }
}

export async function getPost(db, id, { catalog } = {}) {
  id = parseId(id);
  const row = (await db.query("SELECT * FROM social_posts WHERE id = $1", [id])).rows[0];
  if (!row) throw new PipelineError("not_found", "Post not found", 404);
  const { post, violations } = await evaluate(db, row, catalog);
  return { post, violations };
}
export async function listPosts(db, { status, platform, limit = 50 } = {}) {
  const rows = (
    await db.query(
      `SELECT * FROM social_posts WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR platform = $2) ORDER BY id DESC LIMIT $3`,
      [status ?? null, platform ?? null, Math.min(Math.max(Number(limit) || 50, 1), 100)]
    )
  ).rows;
  return rows.map(toPost);
}
export async function listEvents(db, id) {
  id = parseId(id);
  if (!(await db.query("SELECT 1 FROM social_posts WHERE id = $1", [id])).rows.length) throw new PipelineError("not_found", "Post not found", 404);
  return (await db.query("SELECT id, at, actor_type, actor_id, event_type, from_status, to_status, data FROM social_post_events WHERE post_id = $1 ORDER BY id", [id])).rows;
}
