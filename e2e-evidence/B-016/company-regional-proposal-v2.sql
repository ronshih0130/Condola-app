-- PROPOSAL ONLY: UNREVIEWED / UNPARSED / UNAPPLIED / NOT APPLY-READY.
-- Never execute on this Mac. PE must verify actual target, owner, ACLs and backup.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Refuse an unexpected executor; do not invent or transfer to an application role.
DO $admission$
DECLARE trusted_owner oid; gateway oid;
BEGIN
  gateway := pg_catalog.to_regprocedure('app.payee_gateway(uuid,uuid,uuid,text,uuid,text,uuid,jsonb)');
  IF gateway IS NULL THEN RAISE EXCEPTION 'B003 owner anchor missing'; END IF;
  SELECT proowner INTO trusted_owner FROM pg_catalog.pg_proc WHERE oid=gateway;
  IF trusted_owner IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
     OR current_user IN ('anon','authenticated','service_role') THEN
    RAISE EXCEPTION 'unexpected migration owner';
  END IF;
END
$admission$;

CREATE TABLE app.b016_company_profiles (
  org_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  address_schema text NOT NULL CHECK (address_schema='company-tw-text-v1'),
  address jsonb NOT NULL CHECK (
    pg_catalog.jsonb_typeof(address)='object'
    AND address ?& ARRAY['city','district','street']
    AND (address - ARRAY['city','district','street']::text[])='{}'::jsonb
    AND pg_catalog.jsonb_typeof(address->'city')='string'
    AND pg_catalog.jsonb_typeof(address->'district')='string'
    AND pg_catalog.jsonb_typeof(address->'street')='string'
    AND pg_catalog.char_length(address->>'city')<=100
    AND pg_catalog.char_length(address->>'district')<=100
    AND pg_catalog.char_length(address->>'street')<=300
    AND (address->>'city') !~ U&'[\0001-\001F\007F-\009F]'
    AND (address->>'district') !~ U&'[\0001-\001F\007F-\009F]'
    AND (address->>'street') !~ U&'[\0001-\001F\007F-\009F]'
    AND ((address->>'city'='' AND address->>'district'='' AND address->>'street'='') OR address->>'street'<>'')
  ),
  version bigint NOT NULL CHECK (version>0),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_by uuid NOT NULL
);
ALTER TABLE app.b016_company_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.b016_company_profiles FROM PUBLIC, anon, authenticated, service_role;

-- session and selected org are trusted adapter context, never caller-supplied authority.
CREATE FUNCTION app.b016_company_profile_gateway(p_session uuid,p_org uuid,p_op text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET lock_timeout='500ms' AS $gateway$
DECLARE
  actor uuid; s public.auth_sessions%ROWTYPE; o public.organizations%ROWTYPE;
  org_xmin text; flag jsonb; member_role text; jurisdiction_code text; jurisdiction_country text;
  ext app.b016_company_profiles%ROWTYPE; ext_found boolean;
  old_address jsonb; new_address jsonb; old_version bigint; witness text;
  legal_value text; tax_value text; candidate text; field text; max_length integer;
  change_legal boolean:=false; change_tax boolean:=false; change_address boolean:=false;
  changed text[]:=ARRAY[]::text[]; key_count integer;
BEGIN
  IF p_session IS NULL OR p_org IS NULL OR p_op NOT IN ('read','save') OR p_op IS NULL
     OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RETURN pg_catalog.jsonb_build_object('state','unavailable');
  END IF;
  IF (p_op='read' AND p_payload<>'{}'::jsonb)
     OR (p_op='save' AND ((p_payload - ARRAY['expected_version','legal_name','tax_id','address']::text[])<>'{}'::jsonb
       OR pg_catalog.jsonb_typeof(p_payload->'expected_version') IS DISTINCT FROM 'string'
       OR (p_payload->>'expected_version') !~ '^[0-9a-f]{64}$'
       OR NOT (p_payload ?| ARRAY['legal_name','tax_id','address']))) THEN
    RETURN pg_catalog.jsonb_build_object('state','invalid');
  END IF;
  -- These settings are installed by the trusted server adapter from its freshly
  -- resolved session; they are contextual checks, not independent identity proof.
  IF pg_catalog.current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text
     OR pg_catalog.current_setting('app.env',true) IS DISTINCT FROM 'live' THEN
    RETURN pg_catalog.jsonb_build_object('state','unavailable');
  END IF;
  SELECT * INTO s FROM public.auth_sessions WHERE id=p_session FOR SHARE;
  IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=pg_catalog.clock_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object('state','unavailable');
  END IF;
  actor:=s.user_id;
  SELECT value INTO flag FROM public.platform_settings WHERE key='company_regional_profile_edit' FOR SHARE;
  IF NOT FOUND OR pg_catalog.jsonb_typeof(flag) IS DISTINCT FROM 'object'
     OR flag->'enabled' IS DISTINCT FROM 'true'::jsonb
     OR pg_catalog.jsonb_typeof(flag->'allowed_org_ids') IS DISTINCT FROM 'array' THEN
    RETURN pg_catalog.jsonb_build_object('state','unavailable');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(flag->'allowed_org_ids') e(value)
             WHERE pg_catalog.jsonb_typeof(e.value)<>'string'
                OR (e.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR NOT (flag->'allowed_org_ids' @> pg_catalog.jsonb_build_array(p_org::text)) THEN
    RETURN pg_catalog.jsonb_build_object('state','unavailable');
  END IF;
  SELECT * INTO o FROM public.organizations WHERE id=p_org FOR UPDATE;
  IF NOT FOUND OR o.environment::text<>'live' OR o.live_org_id IS NOT NULL
     OR o.feature_flags->'company_regional_profile_edit' IS DISTINCT FROM 'true'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object('state','unavailable');
  END IF;
  SELECT x.xmin::text INTO org_xmin FROM public.organizations x WHERE x.id=p_org;
  SELECT m.role::text INTO member_role FROM public.org_members m
   WHERE m.org_id=p_org AND m.user_id=actor AND m.status='active' FOR SHARE;
  IF NOT FOUND OR member_role<>'admin' THEN RETURN pg_catalog.jsonb_build_object('state','unavailable'); END IF;
  SELECT j.code,j.country_code::text INTO jurisdiction_code,jurisdiction_country
    FROM public.jurisdictions j WHERE j.id=o.jurisdiction_id FOR SHARE;
  IF NOT FOUND OR o.country_code::text<>'TW' OR jurisdiction_code<>'TW' OR jurisdiction_country<>'TW' THEN
    RETURN pg_catalog.jsonb_build_object('state','unavailable');
  END IF;
  SELECT * INTO ext FROM app.b016_company_profiles WHERE org_id=p_org FOR UPDATE;
  ext_found:=FOUND;
  old_address:=CASE WHEN ext_found THEN ext.address ELSE '{"city":"","district":"","street":""}'::jsonb END;
  old_version:=CASE WHEN ext_found THEN ext.version ELSE 0 END;
  IF NOT EXISTS (SELECT 1 FROM public.auth_sessions z WHERE z.id=p_session AND z.user_id=actor
                 AND z.revoked_at IS NULL AND z.expires_at>pg_catalog.clock_timestamp()) THEN
    RETURN pg_catalog.jsonb_build_object('state','unavailable');
  END IF;
  witness:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(p_org::text,org_xmin,
      pg_catalog.to_char(o.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      o.legal_name,o.tax_id,o.country_code::text,o.jurisdiction_id::text,
      CASE WHEN ext_found THEN ext.address_schema ELSE NULL END,old_address,old_version)::text,'UTF8')),'hex');
  IF p_op='read' THEN
    RETURN pg_catalog.jsonb_build_object('state','ready','name',o.name,'country','TW',
      'jurisdiction',jurisdiction_code,'legal_name',o.legal_name,'tax_id',o.tax_id,
      'address',old_address,'expected_version',witness);
  END IF;
  legal_value:=o.legal_name; tax_value:=o.tax_id; new_address:=old_address;
  FOREACH field IN ARRAY ARRAY['legal_name','tax_id'] LOOP
    IF p_payload ? field THEN
      IF pg_catalog.jsonb_typeof(p_payload->field) IS DISTINCT FROM 'string' THEN RETURN pg_catalog.jsonb_build_object('state','invalid'); END IF;
      candidate:=p_payload->>field;
      IF candidate IS NOT DISTINCT FROM (CASE WHEN field='legal_name' THEN o.legal_name ELSE o.tax_id END) THEN CONTINUE; END IF;
      candidate:=pg_catalog.btrim(candidate,U&' \00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
      IF field='legal_name' THEN max_length:=200; ELSE max_length:=100; END IF;
      -- Preserve legacy values if unchanged; changed values must satisfy the new bounds.
      IF NULLIF(candidate,'') IS DISTINCT FROM (CASE WHEN field='legal_name' THEN o.legal_name ELSE o.tax_id END) THEN
        IF pg_catalog.char_length(candidate)>max_length OR candidate ~ U&'[\0001-\001F\007F-\009F]' THEN RETURN pg_catalog.jsonb_build_object('state','invalid'); END IF;
        IF field='legal_name' THEN legal_value:=NULLIF(candidate,'');change_legal:=true; ELSE tax_value:=NULLIF(candidate,'');change_tax:=true; END IF;
        changed:=pg_catalog.array_append(changed,field);
      END IF;
    END IF;
  END LOOP;
  IF p_payload ? 'address' THEN
    new_address:=p_payload->'address';
    IF pg_catalog.jsonb_typeof(new_address) IS DISTINCT FROM 'object'
       OR NOT (new_address ?& ARRAY['city','district','street'])
       OR (new_address - ARRAY['city','district','street']::text[])<>'{}'::jsonb THEN RETURN pg_catalog.jsonb_build_object('state','invalid'); END IF;
    FOREACH field IN ARRAY ARRAY['city','district','street'] LOOP
      IF pg_catalog.jsonb_typeof(new_address->field) IS DISTINCT FROM 'string' THEN RETURN pg_catalog.jsonb_build_object('state','invalid'); END IF;
      candidate:=pg_catalog.btrim(new_address->>field,U&' \00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
      IF field='street' THEN max_length:=300; ELSE max_length:=100; END IF;
      IF pg_catalog.char_length(candidate)>max_length OR candidate ~ U&'[\0001-\001F\007F-\009F]' THEN RETURN pg_catalog.jsonb_build_object('state','invalid'); END IF;
      new_address:=pg_catalog.jsonb_set(new_address,ARRAY[field],pg_catalog.to_jsonb(candidate),false);
    END LOOP;
    IF (new_address->>'city'<>'' OR new_address->>'district'<>'') AND new_address->>'street'='' THEN RETURN pg_catalog.jsonb_build_object('state','invalid'); END IF;
    change_address:=new_address IS DISTINCT FROM old_address;
    IF change_address THEN changed:=pg_catalog.array_append(changed,'address'); END IF;
  END IF;
  IF pg_catalog.cardinality(changed)=0 THEN RETURN pg_catalog.jsonb_build_object('state','unchanged'); END IF;
  IF p_payload->>'expected_version'<>witness THEN RETURN pg_catalog.jsonb_build_object('state','stale'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.auth_sessions z WHERE z.id=p_session AND z.user_id=actor
                 AND z.revoked_at IS NULL AND z.expires_at>pg_catalog.clock_timestamp()) THEN
    RETURN pg_catalog.jsonb_build_object('state','unavailable');
  END IF;
  IF change_legal AND change_tax THEN
    UPDATE public.organizations SET legal_name=legal_value,tax_id=tax_value WHERE id=p_org;
  ELSIF change_legal THEN
    UPDATE public.organizations SET legal_name=legal_value WHERE id=p_org;
  ELSIF change_tax THEN
    UPDATE public.organizations SET tax_id=tax_value WHERE id=p_org;
  END IF;
  IF change_address THEN
    INSERT INTO app.b016_company_profiles AS existing(org_id,address_schema,address,version,updated_at,updated_by)
      VALUES(p_org,'company-tw-text-v1',new_address,1,pg_catalog.clock_timestamp(),actor)
    ON CONFLICT(org_id) DO UPDATE SET address_schema=EXCLUDED.address_schema,address=EXCLUDED.address,
      version=existing.version+1,updated_at=pg_catalog.clock_timestamp(),updated_by=actor;
  END IF;
  INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,new_row,reason)
    VALUES(p_org,actor,'admin','b016_company_profiles',p_org::text,'update','company_regional_profile_changed',
      pg_catalog.jsonb_build_object('event','company_regional_profile_changed','fields',pg_catalog.to_jsonb(changed),
        'outcome','updated','source','settings','environment','live','schema','company-tw-text-v1'),
      'company_regional_profile_changed');
  RETURN pg_catalog.jsonb_build_object('state','updated');
END
$gateway$;
REVOKE ALL ON FUNCTION app.b016_company_profile_gateway(uuid,uuid,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b016_company_profile_gateway(uuid,uuid,text,jsonb) TO service_role;
COMMIT;
