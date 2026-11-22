-- Social publishing (Phase 4, Contract B). Approval-gated posting with stored consent and an append-only audit trail.
-- S7: nothing in these tables holds OAuth tokens, secrets or API keys. Adapters receive credentials from the secrets
-- manager at call time. Do not add credential columns here.

-- Captured reviews. testimonial_share posts may only quote a row with captured_via = 'official_api' and a verified source_url.
CREATE TABLE reviews (
  id              bigserial PRIMARY KEY,
  source          text NOT NULL CHECK (source IN ('google', 'facebook', 'yelp')),
  external_id     text,
  rating          smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  author_display  text CHECK (author_display IS NULL OR length(author_display) <= 120),
  source_url      text CHECK (source_url IS NULL OR length(source_url) <= 2000),
  captured_via    text NOT NULL CHECK (captured_via IN ('official_api', 'manual')),
  captured_at     timestamptz NOT NULL,
  CONSTRAINT official_needs_source CHECK (captured_via <> 'official_api' OR (source_url ~ '^https://' AND external_id IS NOT NULL))
);
CREATE UNIQUE INDEX reviews_source_external_uq ON reviews (source, external_id) WHERE external_id IS NOT NULL;
-- A captured review never changes (so a manual row cannot be upgraded to "official").
CREATE TRIGGER reviews_no_update BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Per-platform consent to publish. One active (granted) row per platform; revoking is immediate and permanent for that row.
CREATE TABLE social_connections (
  id                bigserial PRIMARY KEY,
  platform          text NOT NULL CHECK (platform IN ('gbp', 'facebook', 'instagram', 'youtube')),
  status            text NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'revoked')),
  scope             jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'array' AND jsonb_array_length(scope) > 0),
  consented_by_type text NOT NULL CHECK (consented_by_type = 'user'),
  consented_by_id   text NOT NULL CHECK (length(consented_by_id) > 0),
  consented_at      timestamptz NOT NULL,
  wording_version   text,
  revoked_by_type   text CHECK (revoked_by_type IN ('user', 'agent', 'system', 'webhook')),
  revoked_by_id     text,
  revoked_at        timestamptz,
  CONSTRAINT revoked_fields_match CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by_id IS NOT NULL AND revoked_by_type IS NOT NULL))
);
CREATE UNIQUE INDEX social_connections_one_active_uq ON social_connections (platform) WHERE status = 'granted';

CREATE FUNCTION social_connections_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'social_connections rows are consent proof and are never deleted';
  END IF;
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'a revoked connection cannot change; grant a new one';
  END IF;
  IF NEW.platform IS DISTINCT FROM OLD.platform OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.consented_by_type IS DISTINCT FROM OLD.consented_by_type OR NEW.consented_by_id IS DISTINCT FROM OLD.consented_by_id
     OR NEW.consented_at IS DISTINCT FROM OLD.consented_at OR NEW.wording_version IS DISTINCT FROM OLD.wording_version THEN
    RAISE EXCEPTION 'consent proof fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER social_connections_guard_trg BEFORE UPDATE OR DELETE ON social_connections
  FOR EACH ROW EXECUTE FUNCTION social_connections_guard();

CREATE TABLE social_posts (
  id                   bigserial PRIMARY KEY,
  platform             text NOT NULL CHECK (platform IN ('gbp', 'facebook', 'instagram', 'youtube')),
  kind                 text NOT NULL CHECK (kind IN ('update', 'offer', 'review_reply', 'testimonial_share')),
  content              text NOT NULL CHECK (length(content) BETWEEN 1 AND 5000),
  media                jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(media) = 'array'),
  source_review_id     bigint REFERENCES reviews (id),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'published', 'failed', 'rejected')),
  created_by_type      text NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system', 'webhook')),
  created_by_id        text NOT NULL CHECK (length(created_by_id) > 0),
  last_edited_by_type  text NOT NULL CHECK (last_edited_by_type IN ('user', 'agent', 'system', 'webhook')),
  last_edited_by_id    text NOT NULL CHECK (length(last_edited_by_id) > 0),
  approved_by_type     text CHECK (approved_by_type IN ('user', 'agent', 'system', 'webhook')),
  approved_by_id       text,
  approved_at          timestamptz,
  content_hash         text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  reject_reason        text,
  publish_attempted_at timestamptz,
  published_at         timestamptz,
  external_id          text,
  error                text,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  -- S2 at the database level: an approved or published post always carries a human approver who is not its creator.
  CONSTRAINT approved_needs_human CHECK (
    status NOT IN ('approved', 'published') OR (
      approved_by_type = 'user' AND approved_by_id IS NOT NULL AND approved_at IS NOT NULL AND content_hash IS NOT NULL
      AND lower(btrim(approved_by_id)) <> lower(btrim(created_by_id))
    )
  ),
  CONSTRAINT unapproved_has_no_approval CHECK (
    status NOT IN ('draft', 'pending_approval', 'rejected') OR (approved_by_id IS NULL AND approved_by_type IS NULL AND approved_at IS NULL AND content_hash IS NULL)
  ),
  CONSTRAINT published_needs_external_id CHECK (status <> 'published' OR (external_id IS NOT NULL AND published_at IS NOT NULL AND publish_attempted_at IS NOT NULL))
);
CREATE INDEX social_posts_status_idx ON social_posts (status, id);
CREATE UNIQUE INDEX social_posts_external_uq ON social_posts (platform, external_id) WHERE external_id IS NOT NULL;

-- Append-only audit trail. Never store post text or PII in data; ids, hashes and violation codes only.
CREATE TABLE social_post_events (
  id           bigserial PRIMARY KEY,
  post_id      bigint NOT NULL REFERENCES social_posts (id),
  at           timestamptz NOT NULL,
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'webhook')),
  actor_id     text NOT NULL CHECK (length(actor_id) > 0),
  event_type   text NOT NULL,
  from_status  text,
  to_status    text,
  data         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX social_post_events_post_idx ON social_post_events (post_id, id);
CREATE TRIGGER social_post_events_append_only BEFORE UPDATE OR DELETE ON social_post_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
