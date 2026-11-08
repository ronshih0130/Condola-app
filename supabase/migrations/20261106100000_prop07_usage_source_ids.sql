-- PROP-07 (L1-MTR): metering source-ID retention foundation for B-029 usage events.
-- Append-only private store: every usage row keeps the source table/id it was derived
-- from, a caller-supplied dedupe key and the organization's environment at record time
-- (sandbox rows never count as formal usage). No hooks or callers are added here, so no
-- existing operation writes usage yet. No flag (foundation); no grants to API roles.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE app.usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  dimension text NOT NULL CHECK (dimension IN ('units','signatures','stored_bytes','notifications','vendor_jobs')),
  quantity bigint NOT NULL CHECK (quantity > 0),
  occurred_at timestamptz NOT NULL,
  source_table text NOT NULL CHECK (source_table ~ '^[a-z][a-z0-9_]{0,62}$'),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 128),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  sandbox boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, dimension, dedupe_key)
);
CREATE INDEX usage_events_org_dimension_idx ON app.usage_events(org_id, dimension, occurred_at);
CREATE INDEX usage_events_source_idx ON app.usage_events(source_table, source_id);
ALTER TABLE app.usage_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.usage_events FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.usage_events_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  RAISE EXCEPTION 'Usage events are append-only' USING ERRCODE = '55000';
END $$;
REVOKE ALL ON FUNCTION app.usage_events_immutable() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER usage_events_no_change BEFORE UPDATE OR DELETE ON app.usage_events
FOR EACH ROW EXECUTE FUNCTION app.usage_events_immutable();
CREATE TRIGGER usage_events_no_truncate BEFORE TRUNCATE ON app.usage_events
FOR EACH STATEMENT EXECUTE FUNCTION app.usage_events_immutable();

-- Idempotent recorder for trusted server code (B-029 hooks call it inside a savepoint so a
-- telemetry failure never fails the business operation). Same dedupe key + same payload
-- returns the existing id; a different payload under the same key is a conflict.
CREATE FUNCTION app.prop07_record_usage(p_org uuid, p_dimension text, p_quantity bigint, p_occurred_at timestamptz,
  p_source_table text, p_source_id text, p_dedupe_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE v_env text; v_id uuid; prior app.usage_events%ROWTYPE;
BEGIN
  SELECT environment::text INTO v_env FROM public.organizations WHERE id = p_org;
  IF v_env IS NULL THEN RAISE EXCEPTION 'Usage organization unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('usage:' || p_org::text || ':' || coalesce(p_dimension, '') || ':' || coalesce(p_dedupe_key, ''), 0));
  SELECT * INTO prior FROM app.usage_events WHERE org_id = p_org AND dimension = p_dimension AND dedupe_key = p_dedupe_key;
  IF FOUND THEN
    IF prior.quantity = p_quantity AND prior.occurred_at = p_occurred_at AND prior.source_table = p_source_table AND prior.source_id = p_source_id THEN
      RETURN prior.id;
    END IF;
    RAISE EXCEPTION 'Usage dedupe conflict' USING ERRCODE = '23505';
  END IF;
  INSERT INTO app.usage_events(org_id, dimension, quantity, occurred_at, source_table, source_id, dedupe_key, sandbox)
  VALUES (p_org, p_dimension, p_quantity, p_occurred_at, p_source_table, p_source_id, p_dedupe_key, v_env = 'sandbox')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.prop07_record_usage(uuid, text, bigint, timestamptz, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.prop07_record_usage(uuid, text, bigint, timestamptz, text, text, text) TO service_role;

-- Formal usage summary: sandbox rows excluded. Staff admins of the org (pinned scope) only.
CREATE FUNCTION app.prop07_usage_summary(p_org uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE(dimension text, quantity text, events bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  -- Pinned scope is mandatory here (app.is_member alone admits an unpinned live session).
  IF nullif(current_setting('app.active_org_id', true), '') IS DISTINCT FROM p_org::text
     OR nullif(current_setting('app.env', true), '') IS DISTINCT FROM (SELECT o.environment::text FROM public.organizations o WHERE o.id = p_org)
     OR NOT coalesce(app.has_role(p_org, '{admin}'), false) THEN
    RAISE EXCEPTION 'Usage summary unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT u.dimension, sum(u.quantity)::text, count(*)
    FROM app.usage_events u
    WHERE u.org_id = p_org AND NOT u.sandbox AND u.occurred_at >= p_from AND u.occurred_at < p_to
    GROUP BY u.dimension ORDER BY u.dimension;
END $$;
REVOKE ALL ON FUNCTION app.prop07_usage_summary(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.prop07_usage_summary(uuid, timestamptz, timestamptz) TO authenticated;
COMMIT;
