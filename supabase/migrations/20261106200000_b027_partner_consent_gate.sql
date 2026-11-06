BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Infrastructure only: no document text/version changes and no approval/activation.
INSERT INTO public.platform_settings(key,value) VALUES
  ('partner_consent_gate','{"enabled":false,"allowed_org_ids":[]}'::jsonb),
  ('partner_consent_approved_agreements','{}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Reuse platform_settings for the otherwise missing per-company current approval:
-- {live_org_uuid: {version: existing_version, locale: existing_locale,
--                  sha256: approved_full_text_sha256}}. Empty means unapproved.
-- Only privileged configuration can set this; no client-supplied evidence keys.
CREATE FUNCTION app.b027_require_partner_consent(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE company uuid; approved jsonb;
BEGIN
  SELECT coalesce(live_org_id,id) INTO company FROM public.organizations WHERE id=p_org;
  -- Strict JSON boolean true and valid allowlist + org opt-in, same as slice 3.
  -- Sandbox changes use the canonical live company's gate and approval.
  IF NOT app.b027_flag_on(company,'consent_gate') THEN RETURN; END IF;
  SELECT value->company::text INTO approved FROM public.platform_settings
    WHERE key='partner_consent_approved_agreements';
  IF approved IS NULL OR jsonb_typeof(approved)<>'object'
    OR jsonb_typeof(approved->'version') IS DISTINCT FROM 'string'
    OR btrim(approved->>'version')=''
    OR jsonb_typeof(approved->'locale') IS DISTINCT FROM 'string'
    OR btrim(approved->>'locale')=''
    OR jsonb_typeof(approved->'sha256') IS DISTINCT FROM 'string'
    OR (approved->>'sha256') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.partner_agreement_consents c
    WHERE c.company_id=company AND c.doc_type='partner_agreement'
      AND c.version=approved->>'version' AND c.locale=approved->>'locale'
      AND c.document_sha256=approved->>'sha256'
      AND c.user_id IS NOT NULL AND c.authority_attested IS TRUE
      AND c.actor_role IN ('owner','admin') AND btrim(c.consenter_name)<>''
      AND isfinite(c.consented_at) AND c.consented_at<=clock_timestamp()
      AND isfinite(c.recorded_at) AND c.recorded_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE='42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.b027_require_partner_consent(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Preserve the existing signature, authorization, OFF return and write/audit path.
-- Lock configuration before admission; no new consent or acknowledgement writes.
CREATE OR REPLACE FUNCTION app.b027_change_override(p_org uuid,p_kind text,p_action text,p_units integer,
  p_days integer,p_revision integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE old app.b027_partner_overrides; result app.b027_partner_overrides; instant timestamptz;
BEGIN
  -- Lock order: rollout setting, org, canonical member, override. Kill/opt-out and
  -- membership revocation serialize with admission; OFF never writes domain rows.
  -- A relation lock also covers absent/deleted setting rows: concurrent insertion
  -- of an enabled gate cannot slip between an OFF read and the control write.
  LOCK TABLE public.platform_settings IN SHARE MODE;
  PERFORM 1 FROM public.platform_settings
    WHERE key IN ('partner_consent_gate','partner_consent_approved_agreements','partner_' || p_kind)
    ORDER BY key FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=(SELECT coalesce(live_org_id,id)
    FROM public.organizations WHERE id=p_org) FOR SHARE;
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
  PERFORM app.b027_require_partner_consent(p_org);
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
