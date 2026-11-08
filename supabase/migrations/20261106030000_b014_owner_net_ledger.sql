BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO public.platform_settings(key,value) VALUES
  ('owner_net_ledger','{"enabled":false,"allowed_org_ids":[]}'::jsonb),
  ('monthly_report_delivery','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.b014_statement_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  statement_id uuid NOT NULL,
  version_no int NOT NULL CHECK (version_no >= 2),
  request_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500 AND reason=btrim(reason) AND reason !~ '^[[:space:]]|[[:space:]]$'),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL,
  closing_minor bigint NOT NULL,
  fingerprint text NOT NULL CHECK (length(btrim(fingerprint)) > 0 AND length(fingerprint) <= 128),
  UNIQUE(org_id,statement_id,version_no),
  UNIQUE(org_id,request_id),
  UNIQUE(org_id,statement_id,id),
  FOREIGN KEY(org_id,statement_id) REFERENCES public.owner_statements(org_id,id)
);
CREATE TABLE app.b014_report_delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  statement_id uuid NOT NULL,
  version_id uuid,
  request_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel='email'),
  result text NOT NULL CHECK (result IN ('accepted','delivered','failed','bounced')),
  adapter text NOT NULL CHECK (adapter='mock'),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,request_id),
  FOREIGN KEY(org_id,statement_id) REFERENCES public.owner_statements(org_id,id),
  FOREIGN KEY(org_id,statement_id,version_id) REFERENCES app.b014_statement_versions(org_id,statement_id,id)
);
ALTER TABLE app.b014_statement_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b014_report_delivery_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b014_statement_versions,app.b014_report_delivery_events FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b014_history_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  RAISE EXCEPTION 'Report history is immutable' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION app.b014_history_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b014_versions_no_change BEFORE UPDATE OR DELETE ON app.b014_statement_versions
FOR EACH ROW EXECUTE FUNCTION app.b014_history_immutable();
CREATE TRIGGER b014_versions_no_truncate BEFORE TRUNCATE ON app.b014_statement_versions
FOR EACH STATEMENT EXECUTE FUNCTION app.b014_history_immutable();
CREATE TRIGGER b014_deliveries_no_change BEFORE UPDATE OR DELETE ON app.b014_report_delivery_events
FOR EACH ROW EXECUTE FUNCTION app.b014_history_immutable();
CREATE TRIGGER b014_deliveries_no_truncate BEFORE TRUNCATE ON app.b014_report_delivery_events
FOR EACH STATEMENT EXECUTE FUNCTION app.b014_history_immutable();

CREATE FUNCTION app.b014_flag_on(p_org uuid,p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_settings f JOIN public.organizations o ON o.id=p_org
    WHERE f.key=p_key AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array'
      AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
      AND o.feature_flags->p_key='true'::jsonb
  );
$$;
REVOKE ALL ON FUNCTION app.b014_flag_on(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

-- Writers re-check admission under FOR SHARE row locks held to commit, so a flag
-- turned OFF while a writer waited cannot be bypassed (OFF commits wait or the
-- writer's repeatable-read snapshot fails with a serialization error).
CREATE FUNCTION app.b014_flag_locked(p_org uuid,p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  PERFORM 1 FROM public.platform_settings WHERE key=p_key FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE;
  RETURN app.b014_flag_on(p_org,p_key);
END $$;
REVOKE ALL ON FUNCTION app.b014_flag_locked(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b014_payment_collectors(p_org uuid,p_payments uuid[])
RETURNS TABLE(payment_id uuid,collector text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF NOT app.b014_flag_on(p_org,'owner_net_ledger') OR NOT coalesce(app.has_role(p_org,'{admin,accountant}'),false) THEN
    RAISE EXCEPTION 'Report unavailable' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT p.id, CASE
    WHEN c.confirmed_via IN ('owner_direct','staff_proxy') THEN 'owner_direct'
    WHEN c.confirmed_via='management' THEN 'company'
    WHEN lc.collector='owner' THEN 'owner_direct'
    ELSE 'company' END
  FROM public.payments p
  LEFT JOIN app.b010_payment_confirmations c ON c.org_id=p.org_id AND c.payment_id=p.id
  LEFT JOIN app.b010_lease_collectors lc ON lc.org_id=p.org_id AND lc.lease_id=p.lease_id
  WHERE p.org_id=p_org AND p.id=ANY(p_payments);
END $$;
REVOKE ALL ON FUNCTION app.b014_payment_collectors(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b014_payment_collectors(uuid,uuid[]) TO authenticated;

CREATE FUNCTION app.b014_record_statement_version(p_statement uuid,p_request uuid,p_reason text,p_snapshot jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE
  s public.owner_statements%ROWTYPE;
  prior app.b014_statement_versions%ROWTYPE;
  v_actor uuid := auth.uid();
  v_key text;
  v_id uuid;
  v_version int;
BEGIN
  SELECT * INTO s FROM public.owner_statements WHERE id=p_statement;
  IF NOT FOUND OR s.status<>'issued' OR v_actor IS NULL OR p_request IS NULL
    OR NOT app.b014_flag_on(s.org_id,'owner_net_ledger')
    OR NOT coalesce(app.has_role(s.org_id,'{admin,accountant}'),false) THEN
    RAISE EXCEPTION 'Report unavailable' USING ERRCODE='42501';
  END IF;
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 500 OR p_reason<>btrim(p_reason) OR p_reason ~ '^[[:space:]]|[[:space:]]$'
    OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_snapshot->'currency') IS DISTINCT FROM 'string'
    OR p_snapshot->>'currency' IS DISTINCT FROM s.currency::text
    OR jsonb_typeof(p_snapshot->'fingerprint') IS DISTINCT FROM 'string'
    OR length(btrim(p_snapshot->>'fingerprint'))=0 OR length(p_snapshot->>'fingerprint')>128 THEN
    RAISE EXCEPTION 'Invalid report snapshot' USING ERRCODE='22023';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['opening_minor','company_rent_minor','direct_rent_minor','other_income_minor',
    'management_fee_minor','expenses_minor','payouts_minor','prepay_draws_minor','closing_minor'] LOOP
    IF jsonb_typeof(p_snapshot->v_key) IS DISTINCT FROM 'string'
      OR (p_snapshot->>v_key) !~ '^-?[0-9]{1,19}$' THEN
      RAISE EXCEPTION 'Invalid report amount' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF p_snapshot->>'prepay_draws_minor'<>'0'
    OR (p_snapshot->>'closing_minor')::numeric < -9223372036854775808::numeric
    OR (p_snapshot->>'closing_minor')::numeric > 9223372036854775807::numeric
    OR (p_snapshot->>'closing_minor')::numeric <>
      (p_snapshot->>'opening_minor')::numeric + (p_snapshot->>'company_rent_minor')::numeric
      + (p_snapshot->>'other_income_minor')::numeric - (p_snapshot->>'management_fee_minor')::numeric
      - (p_snapshot->>'expenses_minor')::numeric - (p_snapshot->>'payouts_minor')::numeric THEN
    RAISE EXCEPTION 'Report identity mismatch' USING ERRCODE='22023';
  END IF;
  -- Serialize request reuse even when two callers submit different statements.
  PERFORM pg_advisory_xact_lock(hashtextextended('b014_version_request:'||s.org_id||':'||p_request,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('b014_version:'||p_statement,0));
  IF NOT app.b014_flag_locked(s.org_id,'owner_net_ledger') THEN
    RAISE EXCEPTION 'Report unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO prior FROM app.b014_statement_versions WHERE org_id=s.org_id AND request_id=p_request;
  IF FOUND THEN
    IF prior.statement_id=p_statement AND prior.reason=p_reason AND prior.snapshot=p_snapshot AND prior.actor_user_id=v_actor THEN
      RETURN prior.id;
    END IF;
    RAISE EXCEPTION 'Report request conflict' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(max(version_no),1)+1 INTO v_version FROM app.b014_statement_versions WHERE org_id=s.org_id AND statement_id=p_statement;
  INSERT INTO app.b014_statement_versions(org_id,statement_id,version_no,request_id,reason,actor_user_id,snapshot,closing_minor,fingerprint)
  VALUES(s.org_id,p_statement,v_version,p_request,p_reason,v_actor,p_snapshot,(p_snapshot->>'closing_minor')::bigint,p_snapshot->>'fingerprint')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.b014_record_statement_version(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b014_record_statement_version(uuid,uuid,text,jsonb) TO authenticated;

-- Resolve a committed request id before any recalculation (idempotent retry).
CREATE FUNCTION app.b014_version_for_request(p_statement uuid,p_request uuid)
RETURNS TABLE(id uuid,statement_id uuid,reason text,actor_user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE s public.owner_statements%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.owner_statements st WHERE st.id=p_statement;
  IF NOT FOUND OR NOT app.b014_flag_on(s.org_id,'owner_net_ledger')
    OR NOT coalesce(app.has_role(s.org_id,'{admin,accountant}'),false) THEN
    RAISE EXCEPTION 'Report unavailable' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT v.id,v.statement_id,v.reason,v.actor_user_id FROM app.b014_statement_versions v
    WHERE v.org_id=s.org_id AND v.request_id=p_request;
END $$;
REVOKE ALL ON FUNCTION app.b014_version_for_request(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b014_version_for_request(uuid,uuid) TO authenticated;

CREATE FUNCTION app.b014_statement_versions_for(p_statement uuid)
RETURNS TABLE(id uuid,version_no int,reason text,actor_user_id uuid,created_at timestamptz,snapshot jsonb,actor_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT v.id,v.version_no,v.reason,v.actor_user_id,v.created_at,v.snapshot,pr.display_name
  FROM app.b014_statement_versions v JOIN public.owner_statements s ON s.id=v.statement_id AND s.org_id=v.org_id
  LEFT JOIN public.profiles pr ON pr.id=v.actor_user_id
  WHERE s.id=p_statement AND app.b014_flag_on(s.org_id,'owner_net_ledger')
    AND (app.is_member(s.org_id) OR (s.status='issued' AND app.is_my_contact(s.owner_contact_id)))
  ORDER BY v.version_no DESC;
$$;
REVOKE ALL ON FUNCTION app.b014_statement_versions_for(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b014_statement_versions_for(uuid) TO authenticated;

CREATE FUNCTION app.b014_record_delivery_event(p_statement uuid,p_version uuid,p_request uuid,p_result text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE
  s public.owner_statements%ROWTYPE;
  prior app.b014_report_delivery_events%ROWTYPE;
  v_actor uuid := auth.uid();
  v_id uuid;
BEGIN
  SELECT * INTO s FROM public.owner_statements WHERE id=p_statement;
  IF NOT FOUND OR s.status<>'issued' OR v_actor IS NULL OR p_request IS NULL
    OR NOT app.b014_flag_on(s.org_id,'owner_net_ledger') OR NOT app.b014_flag_on(s.org_id,'monthly_report_delivery')
    OR NOT coalesce(app.has_role(s.org_id,'{admin,accountant}'),false)
    OR p_result IS NULL OR p_result NOT IN ('accepted','delivered','failed','bounced')
    OR (p_version IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.b014_statement_versions v WHERE v.org_id=s.org_id AND v.statement_id=p_statement AND v.id=p_version)) THEN
    RAISE EXCEPTION 'Report delivery unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('b014_delivery_request:'||s.org_id||':'||p_request,0));
  IF NOT app.b014_flag_locked(s.org_id,'owner_net_ledger') OR NOT app.b014_flag_locked(s.org_id,'monthly_report_delivery') THEN
    RAISE EXCEPTION 'Report delivery unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO prior FROM app.b014_report_delivery_events WHERE org_id=s.org_id AND request_id=p_request;
  IF FOUND THEN
    IF prior.statement_id=p_statement AND prior.version_id IS NOT DISTINCT FROM p_version
      AND prior.result=p_result AND prior.channel='email' AND prior.adapter='mock' AND prior.actor_user_id=v_actor THEN
      RETURN prior.id;
    END IF;
    RAISE EXCEPTION 'Report delivery request conflict' USING ERRCODE='42501';
  END IF;
  INSERT INTO app.b014_report_delivery_events(org_id,statement_id,version_id,request_id,channel,result,adapter,actor_user_id)
  VALUES(s.org_id,p_statement,p_version,p_request,'email',p_result,'mock',v_actor) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.b014_record_delivery_event(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b014_record_delivery_event(uuid,uuid,uuid,text) TO authenticated;

CREATE FUNCTION app.b014_delivery_events_for(p_statement uuid)
RETURNS TABLE(id uuid,version_id uuid,channel text,result text,adapter text,actor_user_id uuid,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT e.id,e.version_id,e.channel,e.result,e.adapter,e.actor_user_id,e.created_at
  FROM app.b014_report_delivery_events e JOIN public.owner_statements s ON s.id=e.statement_id AND s.org_id=e.org_id
  WHERE s.id=p_statement AND app.is_member(s.org_id) AND app.b014_flag_on(s.org_id,'owner_net_ledger')
    AND app.b014_flag_on(s.org_id,'monthly_report_delivery')
  ORDER BY e.created_at DESC,e.id;
$$;
REVOKE ALL ON FUNCTION app.b014_delivery_events_for(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b014_delivery_events_for(uuid) TO authenticated;
COMMIT;
