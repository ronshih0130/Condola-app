BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO public.platform_settings(key,value)
VALUES ('INVITE_RESEND_RESULTS','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.b005_resend_requests (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  request_id uuid NOT NULL,
  source_id uuid NOT NULL REFERENCES public.invitations(id),
  generation bigint NOT NULL CHECK (generation >= 0),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('processing','captured','accepted','rejected','unknown')),
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(org_id,actor_id,request_id)
);
CREATE UNIQUE INDEX b005_resend_active_source ON app.b005_resend_requests(org_id,source_id)
  WHERE status <> 'rejected';
ALTER TABLE app.b005_resend_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b005_resend_requests FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b005_resend_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'Resend results are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status <> 'processing' OR NEW.status = 'processing'
    OR (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
    RAISE EXCEPTION 'Resend results are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b005_resend_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b005_resend_no_change BEFORE UPDATE OR DELETE ON app.b005_resend_requests
FOR EACH ROW EXECUTE FUNCTION app.b005_resend_immutable();
CREATE TRIGGER b005_resend_no_truncate BEFORE TRUNCATE ON app.b005_resend_requests
FOR EACH STATEMENT EXECUTE FUNCTION app.b005_resend_immutable();

CREATE FUNCTION app.b005_resend_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT coalesce((SELECT jsonb_typeof(s.value)='object'
    AND s.value->'enabled'='true'::jsonb
    AND jsonb_typeof(s.value->'allowed_org_ids')='array'
    AND (s.value->'allowed_org_ids') @> jsonb_build_array(p_org::text)
    AND jsonb_typeof(o.feature_flags)='object'
    AND o.feature_flags->'INVITE_RESEND_RESULTS'='true'::jsonb
    FROM public.organizations o CROSS JOIN public.platform_settings s
    WHERE o.id=p_org AND s.key='INVITE_RESEND_RESULTS'),false);
$$;
REVOKE ALL ON FUNCTION app.b005_resend_enabled(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- No client snapshot, destination, token, generation or digest is trusted.
-- Both request identity and source reservation are serialized in this short transaction.
CREATE FUNCTION app.b005_resend_claim(p_org uuid,p_source uuid,p_request uuid,p_timeout_ms integer DEFAULT 2000)
RETURNS TABLE(status text,claimed boolean,deadline_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_inv public.invitations%ROWTYPE;
  v_prev app.b005_resend_requests%ROWTYPE;
  v_digest text;
  v_generation bigint;
  v_deadline timestamptz;
BEGIN
  IF v_actor IS NULL OR NOT app.has_role(p_org,'{admin,manager}')
    OR p_org::text IS DISTINCT FROM current_setting('app.active_org_id',true) THEN
    RETURN QUERY SELECT 'unavailable'::text,false,NULL::timestamptz; RETURN;
  END IF;
  IF NOT app.b005_resend_enabled(p_org) THEN
    RETURN QUERY SELECT 'disabled'::text,false,NULL::timestamptz; RETURN;
  END IF;
  IF p_request IS NULL OR p_source IS NULL OR p_timeout_ms IS NULL OR p_timeout_ms NOT BETWEEN 1 AND 30000 THEN
    RETURN QUERY SELECT 'conflict'::text,false,NULL::timestamptz; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('b005:request:'||p_org::text||v_actor::text||p_request::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('b005:source:'||p_org::text||p_source::text,0));
  SELECT * INTO v_inv FROM public.invitations i WHERE i.id=p_source AND i.org_id=p_org AND i.kind IN ('owner','tenant');
  SELECT * INTO v_prev FROM app.b005_resend_requests r WHERE r.org_id=p_org AND r.actor_id=v_actor AND r.request_id=p_request FOR UPDATE;
  IF v_prev.request_id IS NOT NULL AND v_prev.source_id <> p_source THEN
    RETURN QUERY SELECT 'conflict'::text,false,NULL::timestamptz; RETURN;
  END IF;
  IF v_inv.id IS NULL THEN
    RETURN QUERY SELECT 'unavailable'::text,false,NULL::timestamptz; RETURN;
  END IF;
  v_generation := floor(extract(epoch FROM v_inv.created_at)*1000)::bigint;
  v_digest := encode(sha256(convert_to(jsonb_build_array(v_inv.kind,v_inv.contact_id,v_inv.lease_id,
    v_inv.email,v_inv.phone_e164,v_inv.code_hash,v_inv.expires_at)::text,'UTF8')),'hex');
  IF v_prev.request_id IS NOT NULL THEN
    IF v_prev.generation <> v_generation OR v_prev.payload_digest <> v_digest THEN
      RETURN QUERY SELECT 'conflict'::text,false,NULL::timestamptz; RETURN;
    END IF;
    IF v_prev.status='processing' AND v_prev.deadline_at <= clock_timestamp() THEN
      UPDATE app.b005_resend_requests r SET status='unknown',updated_at=clock_timestamp()
      WHERE r.org_id=p_org AND r.actor_id=v_actor AND r.request_id=p_request;
      v_prev.status := 'unknown';
    END IF;
    RETURN QUERY SELECT v_prev.status,false,v_prev.deadline_at; RETURN;
  END IF;
  -- Accepted links and completed contact associations are never reset.
  IF v_inv.status='accepted' OR EXISTS (
    SELECT 1 FROM public.contacts c JOIN auth.users u ON u.id=c.user_id
    WHERE c.org_id=p_org AND c.id=v_inv.contact_id
      AND nullif(btrim(u.encrypted_password),'') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.invitations i WHERE i.org_id=p_org AND i.contact_id=c.id
        AND i.kind IN ('owner','tenant') AND i.status='pending' AND i.expires_at>clock_timestamp())
  ) THEN
    RETURN QUERY SELECT 'already_connected'::text,false,NULL::timestamptz; RETURN;
  END IF;
  IF v_inv.status<>'pending' OR v_inv.expires_at<=clock_timestamp() OR NOT EXISTS (
    SELECT 1 FROM public.contacts c WHERE c.id=v_inv.contact_id AND c.org_id=p_org AND c.archived_at IS NULL
      AND ((v_inv.kind='owner' AND c.is_owner) OR (v_inv.kind='tenant' AND c.is_tenant AND EXISTS (
        SELECT 1 FROM public.lease_parties lp WHERE lp.org_id=p_org AND lp.lease_id=v_inv.lease_id
          AND lp.contact_id=c.id AND lp.role='primary')))
  ) THEN
    RETURN QUERY SELECT 'unavailable'::text,false,NULL::timestamptz; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM app.b005_resend_requests r WHERE r.org_id=p_org AND r.source_id=p_source AND r.status<>'rejected') THEN
    RETURN QUERY SELECT 'conflict'::text,false,NULL::timestamptz; RETURN;
  END IF;
  v_deadline := clock_timestamp()+make_interval(secs=>p_timeout_ms/1000.0);
  INSERT INTO app.b005_resend_requests(org_id,actor_id,request_id,source_id,generation,payload_digest,status,deadline_at)
  VALUES(p_org,v_actor,p_request,p_source,v_generation,v_digest,'processing',v_deadline);
  RETURN QUERY SELECT 'processing'::text,true,v_deadline;
END $$;
REVOKE ALL ON FUNCTION app.b005_resend_claim(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b005_resend_claim(uuid,uuid,uuid,integer) TO authenticated;

CREATE FUNCTION app.b005_resend_settle(p_org uuid,p_request uuid,p_outcome text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_row app.b005_resend_requests%ROWTYPE; v_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT app.has_role(p_org,'{admin,manager}')
    OR p_org::text IS DISTINCT FROM current_setting('app.active_org_id',true) THEN RETURN 'unavailable'; END IF;
  IF NOT app.b005_resend_enabled(p_org) THEN RETURN 'disabled'; END IF;
  SELECT * INTO v_row FROM app.b005_resend_requests r
  WHERE r.org_id=p_org AND r.actor_id=auth.uid() AND r.request_id=p_request FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unavailable'; END IF;
  IF v_row.status <> 'processing' THEN RETURN v_row.status; END IF;
  v_status := CASE WHEN clock_timestamp()>=v_row.deadline_at THEN 'unknown'
    WHEN p_outcome IN ('captured','accepted','rejected') THEN p_outcome ELSE 'unknown' END;
  UPDATE app.b005_resend_requests r SET status=v_status,updated_at=clock_timestamp()
  WHERE r.org_id=p_org AND r.actor_id=auth.uid() AND r.request_id=p_request;
  RETURN v_status;
END $$;
REVOKE ALL ON FUNCTION app.b005_resend_settle(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b005_resend_settle(uuid,uuid,text) TO authenticated;
COMMIT;
