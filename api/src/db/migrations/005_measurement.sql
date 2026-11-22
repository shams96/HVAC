-- Phase 5 measurement: frozen query panels, recorded runs and results, imported metrics, ad spend.

CREATE TABLE panel_versions (
  id           bigserial PRIMARY KEY,
  label        text NOT NULL UNIQUE,
  catalog_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE panel_queries (
  id           bigserial PRIMARY KEY,
  version_id   bigint NOT NULL REFERENCES panel_versions (id),
  position     integer NOT NULL CHECK (position >= 1),
  query_text   text NOT NULL CHECK (length(query_text) BETWEEN 3 AND 200),
  zip          text CHECK (zip ~ '^[0-9]{5}$'),
  service_line text NOT NULL,
  intent       text NOT NULL CHECK (intent IN ('local', 'price', 'urgent', 'trust', 'commercial')),
  UNIQUE (version_id, position),
  UNIQUE (version_id, query_text)
);

-- A panel is frozen the moment it exists: comparability month to month depends on it.
CREATE TRIGGER panel_versions_frozen BEFORE UPDATE OR DELETE ON panel_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER panel_queries_frozen BEFORE UPDATE OR DELETE ON panel_queries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE panel_runs (
  id           bigserial PRIMARY KEY,
  version_id   bigint NOT NULL REFERENCES panel_versions (id),
  run_month    date NOT NULL CHECK (run_month = date_trunc('month', run_month)::date),
  engine       text NOT NULL CHECK (engine IN ('google_search', 'google_ai_overview', 'bing_search', 'bing_copilot', 'chatgpt_search', 'perplexity', 'gemini')),
  method       text NOT NULL CHECK (method IN ('manual', 'official_api')),
  run_by       text NOT NULL CHECK (length(run_by) > 0),
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (version_id, run_month, engine)
);

CREATE TABLE panel_results (
  id            bigserial PRIMARY KEY,
  run_id        bigint NOT NULL REFERENCES panel_runs (id),
  query_id      bigint NOT NULL REFERENCES panel_queries (id),
  our_appeared  boolean NOT NULL,
  our_position  integer,
  our_cited     boolean NOT NULL DEFAULT false,
  cited_urls    jsonb NOT NULL DEFAULT '[]',
  cited_domains jsonb NOT NULL DEFAULT '[]',
  evidence_ref  text,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, query_id),
  CONSTRAINT position_needs_appearance CHECK (our_position IS NULL OR (our_appeared AND our_position BETWEEN 1 AND 100))
);

-- Results must belong to the run's own panel version, and a completed run is immutable.
CREATE FUNCTION panel_results_guard() RETURNS trigger AS $$
DECLARE
  done timestamptz;
  run_version bigint;
  query_version bigint;
BEGIN
  SELECT completed_at, version_id INTO done, run_version FROM panel_runs WHERE id = COALESCE(NEW.run_id, OLD.run_id);
  IF done IS NOT NULL THEN
    RAISE EXCEPTION 'panel_results of a completed run are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT version_id INTO query_version FROM panel_queries WHERE id = NEW.query_id;
  IF query_version IS DISTINCT FROM run_version THEN
    RAISE EXCEPTION 'query % does not belong to the run''s panel version', NEW.query_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER panel_results_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON panel_results
  FOR EACH ROW EXECUTE FUNCTION panel_results_guard();

CREATE FUNCTION panel_runs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'panel_runs cannot be deleted'; END IF;
  IF OLD.completed_at IS NOT NULL THEN RAISE EXCEPTION 'a completed panel run is immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER panel_runs_guard_trg BEFORE UPDATE OR DELETE ON panel_runs
  FOR EACH ROW EXECUTE FUNCTION panel_runs_guard();

-- Imported measurements, calendar-month granularity, idempotent per (source, metric, month, dimension).
CREATE TABLE metrics (
  id           bigserial PRIMARY KEY,
  source       text NOT NULL CHECK (source IN ('gsc', 'gbp', 'analytics', 'call_tracking', 'manual')),
  metric       text NOT NULL,
  period_start date NOT NULL CHECK (period_start = date_trunc('month', period_start)::date),
  dim_type     text NOT NULL CHECK (dim_type IN ('zip', 'branch', 'page', 'site')),
  dim_value    text NOT NULL DEFAULT '',
  value        numeric NOT NULL CHECK (value >= 0),
  import_batch text NOT NULL,
  imported_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, metric, period_start, dim_type, dim_value)
);

CREATE TABLE ad_spend (
  id           bigserial PRIMARY KEY,
  month        date NOT NULL CHECK (month = date_trunc('month', month)::date),
  channel      text NOT NULL CHECK (length(channel) BETWEEN 1 AND 60),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (month, channel)
);
