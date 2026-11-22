-- Lead pipeline schema (PostgreSQL). System of record for intake, stage history and consent.

CREATE TABLE accounts (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('commercial', 'property_management', 'residential')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_name_kind_uq ON accounts (lower(name), kind);

CREATE TABLE contacts (
  id             bigserial PRIMARY KEY,
  name           text,
  phone_e164     text,
  email          text,
  role           text,
  account_id     bigint REFERENCES accounts (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  anonymized_at  timestamptz
);
CREATE UNIQUE INDEX contacts_phone_uq ON contacts (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX contacts_email_uq ON contacts (email) WHERE email IS NOT NULL;

CREATE TABLE sites (
  id              bigserial PRIMARY KEY,
  account_id      bigint NOT NULL REFERENCES accounts (id),
  label           text NOT NULL,
  street_address  text,
  zip             text CHECK (zip ~ '^[0-9]{5}$'),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agreements (
  id          bigserial PRIMARY KEY,
  account_id  bigint NOT NULL REFERENCES accounts (id),
  site_id     bigint REFERENCES sites (id),
  kind        text NOT NULL,
  starts_on   date NOT NULL,
  ends_on     date,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE routing_rules (
  id              bigserial PRIMARY KEY,
  zip             text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  service_line    text NOT NULL DEFAULT '*',
  branch_id       text NOT NULL,
  assignee_group  text,
  UNIQUE (zip, service_line)
);

CREATE TABLE leads (
  id              bigserial PRIMARY KEY,
  type            text NOT NULL CHECK (type IN ('B2C', 'B2B')),
  channel         text NOT NULL CHECK (channel IN ('call', 'form', 'chat', 'booking')),
  contact_id      bigint NOT NULL REFERENCES contacts (id),
  account_id      bigint REFERENCES accounts (id),
  zip             text CHECK (zip ~ '^[0-9]{5}$'),
  service_line    text NOT NULL,
  stage           text NOT NULL,
  emergency       boolean NOT NULL DEFAULT false,
  branch_id       text,
  assignee_group  text,
  routed_by       text NOT NULL CHECK (routed_by IN ('zip+service', 'zip', 'unrouted')),
  sla_due_at      timestamptz NOT NULL,
  sla_breached_at timestamptz,
  details         jsonb NOT NULL DEFAULT '{}',
  source          text,
  lost_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  CONSTRAINT stage_valid_for_type CHECK (
    (type = 'B2C' AND stage IN ('new', 'contacted', 'booked', 'won', 'lost')) OR
    (type = 'B2B' AND stage IN ('lead', 'site_visit', 'quote', 'negotiation', 'won', 'lost'))
  ),
  CONSTRAINT lost_needs_reason CHECK (stage <> 'lost' OR (lost_reason IS NOT NULL AND length(trim(lost_reason)) > 0))
);
CREATE INDEX leads_open_dedupe_idx ON leads (contact_id, service_line) WHERE stage NOT IN ('won', 'lost');
CREATE INDEX leads_sla_idx ON leads (sla_due_at) WHERE sla_breached_at IS NULL AND stage IN ('new', 'lead');

-- Append-only audit trail. Never store PII in data; reference ids only.
CREATE TABLE lead_events (
  id          bigserial PRIMARY KEY,
  lead_id     bigint NOT NULL REFERENCES leads (id),
  at          timestamptz NOT NULL DEFAULT now(),
  actor_type  text NOT NULL CHECK (actor_type IN ('user', 'system', 'agent', 'webhook', 'customer')),
  actor_id    text NOT NULL CHECK (length(actor_id) > 0),
  event_type  text NOT NULL,
  from_stage  text,
  to_stage    text,
  data        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX lead_events_lead_idx ON lead_events (lead_id, id);

-- Append-only consent proof. Latest record per contact and channel wins. No record = no consent.
CREATE TABLE consent_records (
  id              bigserial PRIMARY KEY,
  contact_id      bigint NOT NULL REFERENCES contacts (id),
  channel         text NOT NULL CHECK (channel IN ('call', 'sms', 'email', 'marketing')),
  status          text NOT NULL CHECK (status IN ('granted', 'revoked')),
  wording_version text,
  source          text NOT NULL,
  captured_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_contact_channel_idx ON consent_records (contact_id, channel, id);

-- Transactional outbox for CRM sync. Payload (with PII) is built at send time, never stored here.
CREATE TABLE crm_outbox (
  id               bigserial PRIMARY KEY,
  lead_id          bigint NOT NULL REFERENCES leads (id),
  event_id         bigint NOT NULL REFERENCES lead_events (id),
  event_type       text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX crm_outbox_pending_idx ON crm_outbox (next_attempt_at) WHERE status = 'pending';

CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lead_events_append_only BEFORE UPDATE OR DELETE ON lead_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER consent_records_append_only BEFORE UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
