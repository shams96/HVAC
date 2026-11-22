-- Chat agent schema. The model never writes here directly: only the harness does.
-- The conversation token is stored as a SHA-256 hash; the raw token exists only in the customer's browser.

CREATE TABLE conversations (
  id          bigserial PRIMARY KEY,
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  turns       integer NOT NULL DEFAULT 0,
  emergency   boolean NOT NULL DEFAULT false   -- set only by the deterministic pre-check, never by the model
);

-- Transcript. content is nulled by purgeChats() after the retention window.
CREATE TABLE chat_messages (
  id               bigserial PRIMARY KEY,
  conversation_id  bigint NOT NULL REFERENCES conversations (id),
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  content          text,
  created_at       timestamptz NOT NULL,
  purged_at        timestamptz
);
CREATE INDEX chat_messages_conv_idx ON chat_messages (conversation_id, id);

-- State-changing proposals. A row here means "proposed", nothing more. Only /api/chat/confirm executes.
CREATE TABLE pending_actions (
  id               text PRIMARY KEY,
  conversation_id  bigint NOT NULL REFERENCES conversations (id),
  kind             text NOT NULL CHECK (kind IN ('request_estimate', 'book_appointment', 'request_handoff')),
  args             jsonb NOT NULL,
  summary          text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'expired')),
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  resolved_at      timestamptz,
  result           jsonb
);
CREATE INDEX pending_actions_conv_idx ON pending_actions (conversation_id, status);

-- Append-only action log. Ids and reason codes only, never message text or contact details.
CREATE TABLE agent_actions_log (
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL,
  conversation_id  bigint REFERENCES conversations (id),
  action_id        text,
  actor_type       text NOT NULL CHECK (actor_type IN ('agent', 'customer', 'system')),
  event            text NOT NULL CHECK (event IN ('proposed', 'confirmed', 'rejected', 'expired', 'blocked')),
  data             jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX agent_actions_log_conv_idx ON agent_actions_log (conversation_id, id);

CREATE TRIGGER agent_actions_log_append_only BEFORE UPDATE OR DELETE ON agent_actions_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER agent_actions_log_no_truncate BEFORE TRUNCATE ON agent_actions_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
