-- Per-user staff authentication: accounts, sessions (token hashes only) and an append-only auth event log.

CREATE TABLE staff_users (
  id                  bigserial PRIMARY KEY,
  email               text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 64),
  display_name        text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  role                text NOT NULL CHECK (role IN ('staff', 'approver', 'admin')),
  password_hash       text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_logins       integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  disabled_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_sessions (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES staff_users (id),
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX staff_sessions_user ON staff_sessions (user_id);

CREATE TABLE staff_auth_events (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL,
  user_id         bigint REFERENCES staff_users (id),
  email_attempted text,
  event           text NOT NULL CHECK (event IN (
    'login_ok', 'login_failed', 'login_locked', 'logout', 'password_changed', 'password_reset',
    'user_created', 'user_disabled'
  )),
  ip              text
);
CREATE TRIGGER staff_auth_events_append_only BEFORE UPDATE OR DELETE ON staff_auth_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
