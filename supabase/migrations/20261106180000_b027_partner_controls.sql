BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO public.platform_settings(key,value) VALUES
  ('partner_pricing_hide','{"enabled":false,"allowed_org_ids":[]}'::jsonb),
  ('partner_unit_override','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.b027_partner_overrides (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  kind text NOT NULL CHECK (kind IN ('pricing_hide','unit_override')),
  unit_limit integer,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  revision integer NOT NULL CHECK (revision > 0),
  revoked boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id,kind),
  CHECK (expires_at > starts_at AND expires_at - starts_at <= interval '720 hours'
    AND isfinite(starts_at) AND isfinite(expires_at)),
  CHECK ((kind='pricing_hide' AND unit_limit IS NULL)
    OR (kind='unit_override' AND unit_limit IS NOT NULL AND unit_limit BETWEEN 1 AND 10000))
);
CREATE TABLE app.b027_partner_override_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  kind text NOT NULL,
  revision integer NOT NULL,
  action text NOT NULL CHECK (action IN ('create','renew','revoke')),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Typed facts only: no free text, names, email, tokens or IP addresses.
  unit_limit integer,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE(org_id,kind,revision),
  FOREIGN KEY(org_id,kind) REFERENCES app.b027_partner_overrides(org_id,kind)
);
ALTER TABLE app.b027_partner_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b027_partner_override_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b027_partner_overrides,app.b027_partner_override_events FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b027_event_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Partner history is immutable' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION app.b027_event_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b027_event_no_change BEFORE UPDATE OR DELETE ON app.b027_partner_override_events
FOR EACH ROW EXECUTE FUNCTION app.b027_event_immutable();
CREATE TRIGGER b027_event_no_truncate BEFORE TRUNCATE ON app.b027_partner_override_events
FOR EACH STATEMENT EXECUTE FUNCTION app.b027_event_immutable();

-- Mandatory pin and canonical live membership, including linked sandbox selection.
CREATE FUNCTION app.b027_scope(p_org uuid,p_admin boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.org_members m
    ON m.org_id=coalesce(o.live_org_id,o.id) AND m.user_id=auth.uid() AND m.status='active'
    WHERE o.id=p_org AND current_setting('app.active_org_id',true)=o.id::text
      AND current_setting('app.env',true)=o.environment::text
      AND ((o.environment='live' AND o.live_org_id IS NULL)
        OR (o.environment='sandbox' AND o.live_org_id IS NOT NULL))
      AND (NOT p_admin OR m.role='admin'));
$$;
REVOKE ALL ON FUNCTION app.b027_scope(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b027_flag_on(p_org uuid,p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_settings f JOIN public.organizations o ON o.id=p_org
    WHERE f.key='partner_' || p_kind AND jsonb_typeof(f.value)='object'
      AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(o.feature_flags)='object'
      AND o.feature_flags->('partner_' || p_kind)='true'::jsonb
      AND CASE WHEN jsonb_typeof(f.value->'allowed_org_ids')='array' THEN
        NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.value->'allowed_org_ids') item
          WHERE jsonb_typeof(item)<>'string' OR (item #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
      ELSE false END);
$$;
REVOKE ALL ON FUNCTION app.b027_flag_on(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

-- Read-only: the server's pure evaluator applies the caller's instant to these facts.
CREATE FUNCTION app.b027_read_controls(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF NOT app.b027_scope(p_org,false) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object(
    'flags',(SELECT feature_flags FROM public.organizations WHERE id=p_org),
    'platform',coalesce((SELECT jsonb_object_agg(key,value) FROM public.platform_settings
      WHERE key IN ('partner_pricing_hide','partner_unit_override')),'{}'::jsonb),
    'overrides',coalesce((SELECT jsonb_agg(jsonb_build_object('kind',kind,'unitLimit',unit_limit,
      'startsAt',starts_at,'expiresAt',expires_at,'revoked',revoked,'revision',revision))
      FROM app.b027_partner_overrides WHERE org_id=p_org AND app.b027_flag_on(p_org,kind)),'[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION app.b027_read_controls(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b027_read_controls(uuid) TO authenticated;

-- Server-only writer: recordAudit runs on the same service transaction. API clients
-- cannot invoke this directly or bypass the masked application audit.
CREATE FUNCTION app.b027_change_override(p_org uuid,p_kind text,p_action text,p_units integer,
  p_days integer,p_revision integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE old app.b027_partner_overrides; result app.b027_partner_overrides; instant timestamptz;
BEGIN
  -- Lock order: rollout setting, org, canonical member, override. Kill/opt-out and
  -- membership revocation serialize with admission; OFF never writes domain rows.
  PERFORM 1 FROM public.platform_settings WHERE key='partner_' || p_kind FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE;
  PERFORM 1 FROM public.org_members WHERE org_id=(SELECT coalesce(live_org_id,id)
    FROM public.organizations WHERE id=p_org) AND user_id=auth.uid() FOR SHARE;
  IF NOT app.b027_scope(p_org,true) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE='42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('pricing_hide','unit_override')
    OR p_action IS NULL OR p_action NOT IN ('create','renew','revoke') THEN
    RAISE EXCEPTION 'Invalid partner command' USING ERRCODE='22023';
  END IF;
  IF NOT app.b027_flag_on(p_org,p_kind) THEN RETURN NULL; END IF;
  -- Serialize initial creation as well as revision CAS; no unbounded renewal stacking.
  PERFORM pg_advisory_xact_lock(hashtextextended('b027:' || p_org::text || ':' || p_kind,0));
  SELECT * INTO old FROM app.b027_partner_overrides WHERE org_id=p_org AND kind=p_kind FOR UPDATE;
  IF p_revision IS NULL OR (p_action='create' AND (old.org_id IS NOT NULL OR p_revision<>0))
    OR (p_action<>'create' AND (old.org_id IS NULL OR old.revision<>p_revision OR old.revoked)) THEN
    RAISE EXCEPTION 'Partner revision conflict' USING ERRCODE='40001';
  END IF;
  instant := clock_timestamp();
  IF p_action<>'revoke' THEN
    IF p_days IS NULL OR p_days<1 OR p_days>30
      OR (p_kind='pricing_hide' AND p_units IS NOT NULL)
      OR (p_kind='unit_override' AND (p_units IS NULL OR p_units<1 OR p_units>10000))
      OR (p_action='renew' AND p_units IS DISTINCT FROM old.unit_limit) THEN
      RAISE EXCEPTION 'Invalid partner term' USING ERRCODE='22023';
    END IF;
    INSERT INTO app.b027_partner_overrides(org_id,kind,unit_limit,starts_at,expires_at,created_by,revision)
      VALUES(p_org,p_kind,p_units,instant,instant + p_days * interval '24 hours',auth.uid(),1)
    ON CONFLICT(org_id,kind) DO UPDATE SET starts_at=EXCLUDED.starts_at,expires_at=EXCLUDED.expires_at,
      revision=b027_partner_overrides.revision+1;
  ELSE
    UPDATE app.b027_partner_overrides SET revoked=true,revision=revision+1 WHERE org_id=p_org AND kind=p_kind;
  END IF;
  SELECT * INTO result FROM app.b027_partner_overrides WHERE org_id=p_org AND kind=p_kind;
  INSERT INTO app.b027_partner_override_events(org_id,kind,revision,action,actor_user_id,unit_limit,starts_at,expires_at)
    VALUES(p_org,p_kind,result.revision,p_action,auth.uid(),result.unit_limit,result.starts_at,result.expires_at);
  RETURN jsonb_build_object('kind',result.kind,'unitLimit',result.unit_limit,'startsAt',result.starts_at,
    'expiresAt',result.expires_at,'revoked',result.revoked,'revision',result.revision);
END $$;
REVOKE ALL ON FUNCTION app.b027_change_override(uuid,text,text,integer,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b027_change_override(uuid,text,text,integer,integer,integer) TO service_role;
COMMIT;
