-- Common durable ownership only. No transport and no changes to existing producers.
INSERT INTO public.platform_settings(key,value)
VALUES ('notification_delivery_v2','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.b028_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  source_kind text NOT NULL CHECK (source_kind ~ '^[a-z][a-z0-9_]{0,99}$'),
  source_id uuid NOT NULL,
  recipient_key text NOT NULL CHECK (char_length(recipient_key) BETWEEN 1 AND 200 AND recipient_key ~ '^[A-Za-z0-9][A-Za-z0-9:._/-]*$'),
  channel text NOT NULL CHECK (channel IN ('email','line')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','captured','accepted','failed','unknown')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 5),
  claim_token_hash text CHECK (claim_token_hash ~ '^[0-9a-f]{64}$'),
  claim_expires_at timestamptz,
  provider_ref text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id,source_kind,source_id,recipient_key,channel),
  CHECK ((status='claimed' AND claim_token_hash IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR (status<>'claimed' AND claim_token_hash IS NULL AND claim_expires_at IS NULL))
);
CREATE INDEX b028_delivery_pending ON app.b028_delivery_attempts(org_id,channel,created_at,id)
  WHERE status IN ('queued','claimed');
CREATE TABLE app.b028_delivery_attempt_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES app.b028_delivery_attempts(id),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  status text NOT NULL CHECK (status IN ('queued','claimed','captured','accepted','failed','unknown')),
  attempt integer NOT NULL CHECK (attempt BETWEEN 0 AND 5),
  provider_ref text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE app.b028_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b028_delivery_attempt_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b028_delivery_attempts,app.b028_delivery_attempt_events FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b028_delivery_record_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
BEGIN
  INSERT INTO app.b028_delivery_attempt_events(attempt_id,org_id,status,attempt,provider_ref,failure_code)
    VALUES(NEW.id,NEW.org_id,NEW.status,NEW.attempt,NEW.provider_ref,NEW.failure_code);
  RETURN NULL;
END $$;
CREATE TRIGGER b028_delivery_record_event AFTER INSERT OR UPDATE ON app.b028_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION app.b028_delivery_record_event();
CREATE FUNCTION app.b028_delivery_events_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
BEGIN RAISE EXCEPTION 'Immutable delivery event' USING ERRCODE='42501'; END $$;
CREATE TRIGGER b028_delivery_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON app.b028_delivery_attempt_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.b028_delivery_events_immutable();
REVOKE ALL ON FUNCTION app.b028_delivery_record_event(),app.b028_delivery_events_immutable() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b028_delivery_enabled(p_org uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
BEGIN
  -- Explicit org arguments are trusted service inputs; a pinned context cannot cross orgs.
  IF nullif(current_setting('app.active_org_id',true),'') IS NOT NULL
     AND current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text THEN
    RETURN false;
  END IF;
  LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
  PERFORM 1 FROM public.organizations o WHERE o.id=p_org FOR SHARE NOWAIT;
  RETURN (EXISTS (SELECT 1 FROM public.organizations o
    JOIN public.platform_settings f ON f.key='notification_delivery_v2'
    WHERE o.id=p_org AND (o.feature_flags->'notification_delivery_v2'='true'::jsonb) IS TRUE
      AND (f.value->'enabled'='true'::jsonb) IS TRUE
      AND (jsonb_typeof(f.value->'allowed_org_ids')='array') IS TRUE
      AND (f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) IS TRUE)) IS TRUE;
END $$;

CREATE FUNCTION app.b028_delivery_enqueue(p_org uuid,p_source_kind text,p_source_id uuid,p_recipient_key text,p_channel text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE v_id uuid;
BEGIN
  IF app.b028_delivery_enabled(p_org) IS NOT TRUE THEN
    RAISE EXCEPTION 'Delivery unavailable' USING ERRCODE='42501';
  END IF;
  INSERT INTO app.b028_delivery_attempts(org_id,source_kind,source_id,recipient_key,channel)
    VALUES(p_org,p_source_kind,p_source_id,p_recipient_key,p_channel)
    ON CONFLICT (org_id,source_kind,source_id,recipient_key,channel) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT a.id INTO v_id FROM app.b028_delivery_attempts a WHERE a.org_id=p_org
      AND a.source_kind=p_source_kind AND a.source_id=p_source_id AND a.recipient_key=p_recipient_key AND a.channel=p_channel;
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION app.b028_delivery_claim(p_org uuid,p_channel text,p_limit integer,p_ttl_seconds integer)
RETURNS TABLE(attempt_id uuid,token text,source_kind text,source_id uuid,recipient_key text,attempt integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE v_row app.b028_delivery_attempts%ROWTYPE; v_token text;
BEGIN
  IF app.b028_delivery_enabled(p_org) IS NOT TRUE THEN RETURN; END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('email','line') OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
    OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'Invalid delivery claim' USING ERRCODE='22023';
  END IF;
  FOR v_row IN SELECT a.* FROM app.b028_delivery_attempts a
    WHERE a.org_id=p_org AND a.channel=p_channel
      AND (a.status='queued' OR (a.status='claimed' AND a.claim_expires_at<=clock_timestamp()))
    ORDER BY a.created_at,a.id LIMIT p_limit FOR UPDATE OF a SKIP LOCKED
  LOOP
    IF v_row.attempt>=5 THEN
      UPDATE app.b028_delivery_attempts SET status='failed',claim_token_hash=NULL,claim_expires_at=NULL,
        failure_code='claim_expired',updated_at=clock_timestamp() WHERE id=v_row.id;
      CONTINUE;
    END IF;
    v_token:=encode(public.gen_random_bytes(32),'hex');
    UPDATE app.b028_delivery_attempts SET status='claimed',attempt=v_row.attempt+1,
      claim_token_hash=encode(public.digest(v_token,'sha256'),'hex'),
      claim_expires_at=clock_timestamp()+make_interval(secs=>p_ttl_seconds),
      provider_ref=NULL,failure_code=NULL,updated_at=clock_timestamp() WHERE id=v_row.id;
    RETURN QUERY SELECT v_row.id,v_token,v_row.source_kind,v_row.source_id,v_row.recipient_key,v_row.attempt+1;
  END LOOP;
END $$;

CREATE FUNCTION app.b028_delivery_complete(p_attempt uuid,p_token text,p_result text,p_provider_ref text,p_failure_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE v_org uuid; v_attempt integer;
BEGIN
  -- Completion has no org parameter: the service must pin its org in this transaction.
  SELECT o.id INTO v_org FROM public.organizations o
    WHERE o.id::text=nullif(current_setting('app.active_org_id',true),'');
  IF v_org IS NULL OR app.b028_delivery_enabled(v_org) IS NOT TRUE THEN
    RAISE EXCEPTION 'Delivery unavailable' USING ERRCODE='42501';
  END IF;
  IF p_result IS NULL OR p_result NOT IN ('captured','accepted','failed','unknown') THEN
    RAISE EXCEPTION 'Invalid delivery result' USING ERRCODE='22023';
  END IF;
  SELECT a.attempt INTO v_attempt FROM app.b028_delivery_attempts a
    WHERE a.id=p_attempt AND a.org_id=v_org FOR UPDATE NOWAIT; -- row contention => 55P03 busy; other lock waits bounded by lock_timeout (55P03)
  UPDATE app.b028_delivery_attempts SET status=p_result,provider_ref=p_provider_ref,failure_code=p_failure_code,
    claim_token_hash=NULL,claim_expires_at=NULL,updated_at=clock_timestamp()
    WHERE id=p_attempt AND org_id=v_org AND status='claimed' AND claim_expires_at>clock_timestamp()
      AND claim_token_hash=encode(public.digest(p_token,'sha256'),'hex');
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery unavailable' USING ERRCODE='42501'; END IF;
  IF p_result='failed' AND v_attempt<5 THEN
    UPDATE app.b028_delivery_attempts SET status='queued',updated_at=clock_timestamp() WHERE id=p_attempt;
  END IF;
END $$;

CREATE FUNCTION app.b028_delivery_status(p_org uuid,p_source_kind text,p_source_id uuid)
RETURNS TABLE(status text,count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
BEGIN
  IF app.b028_delivery_enabled(p_org) IS NOT TRUE THEN RETURN; END IF;
  RETURN QUERY SELECT a.status,count(*) FROM app.b028_delivery_attempts a
    WHERE a.org_id=p_org AND a.source_kind=p_source_kind AND a.source_id=p_source_id GROUP BY a.status;
END $$;

REVOKE ALL ON FUNCTION app.b028_delivery_enabled(uuid),app.b028_delivery_enqueue(uuid,text,uuid,text,text),
  app.b028_delivery_claim(uuid,text,integer,integer),app.b028_delivery_complete(uuid,text,text,text,text),
  app.b028_delivery_status(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_delivery_enabled(uuid),app.b028_delivery_enqueue(uuid,text,uuid,text,text),
  app.b028_delivery_claim(uuid,text,integer,integer),app.b028_delivery_complete(uuid,text,text,text,text),
  app.b028_delivery_status(uuid,text,uuid) TO service_role;

-- 'unknown' (adapter timed out or outcome ambiguous) is terminal for automatic processing:
-- never re-claimed or auto-retried; it must be reconciled before any retry (no duplicate send).
COMMENT ON COLUMN app.b028_delivery_attempts.status IS 'queued|claimed|captured|accepted|failed|unknown; unknown is never auto-retried';
