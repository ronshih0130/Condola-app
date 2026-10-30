-- B013/B021 settings foundation. Unpublished draft; no repair authorization,
-- dispatch, estimate approval, financial posting or provider delivery is added.
BEGIN;

INSERT INTO public.platform_settings(key,value,description)
VALUES('repair_approvals','{"enabled":false,"allowed_org_ids":[]}'::jsonb,'Owner repair policy and versioned approval rollout')
ON CONFLICT(key) DO NOTHING;

CREATE TABLE app.b013_regional_defaults(
 country_code text NOT NULL CHECK(country_code ~ '^[A-Z]{2}$'),
 currency char(3) NOT NULL REFERENCES public.currencies(code),
 threshold_minor bigint NOT NULL CHECK(threshold_minor>=0),
 minor_unit smallint NOT NULL CHECK(minor_unit BETWEEN 0 AND 4),
 revision uuid NOT NULL DEFAULT gen_random_uuid(),
 source text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(country_code,currency)
);
-- The approved regional rule is configuration, never a universal fallback.
INSERT INTO app.b013_regional_defaults(country_code,currency,threshold_minor,minor_unit,source)
VALUES('TW','TWD',500000,2,'Ron approved regional owner threshold');

CREATE TABLE app.b013_default_roots(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 principal_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 currency char(3) NOT NULL REFERENCES public.currencies(code),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 current_revision uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,principal_id,currency),
 UNIQUE(org_id,id),
 UNIQUE(org_id,id,principal_id,currency),
 CHECK((version=0 AND current_revision IS NULL) OR(version>0 AND current_revision IS NOT NULL))
);
CREATE TABLE app.b013_default_revisions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 root_id uuid NOT NULL,
 principal_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 currency char(3) NOT NULL,
 minor_unit smallint NOT NULL CHECK(minor_unit BETWEEN 0 AND 4),
 revision_no bigint NOT NULL CHECK(revision_no>0),
 mode text NOT NULL CHECK(mode IN('set','clear')),
 threshold_minor bigint,
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 session_id uuid NOT NULL,
 request_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(actor_id=principal_id),
 CHECK((mode='set' AND threshold_minor IS NOT NULL AND threshold_minor>=0) OR(mode='clear' AND threshold_minor IS NULL)),
 UNIQUE(org_id,root_id,revision_no),
 UNIQUE(org_id,root_id,id,revision_no),
 FOREIGN KEY(org_id,root_id,principal_id,currency) REFERENCES app.b013_default_roots(org_id,id,principal_id,currency) ON DELETE CASCADE
);
ALTER TABLE app.b013_default_roots ADD CONSTRAINT b013_current_default_revision
 FOREIGN KEY(org_id,id,current_revision,version) REFERENCES app.b013_default_revisions(org_id,root_id,id,revision_no)
 DEFERRABLE INITIALLY DEFERRED;

-- These are immutable confirmations of the EXISTING public override column,
-- not a second mutable property threshold authority.
CREATE TABLE app.b013_override_revisions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 ownership_id uuid NOT NULL,
 principal_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 currency char(3) NOT NULL REFERENCES public.currencies(code),
 minor_unit smallint NOT NULL CHECK(minor_unit BETWEEN 0 AND 4),
 revision_no bigint NOT NULL CHECK(revision_no>0),
 mode text NOT NULL CHECK(mode IN('set','clear')),
 threshold_minor bigint,
 source_row_version bigint NOT NULL CHECK(source_row_version>=0),
 source_row_hash text NOT NULL CHECK(source_row_hash ~ '^[0-9a-f]{64}$'),
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 session_id uuid NOT NULL,
 request_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(actor_id=principal_id),
 CHECK((mode='set' AND threshold_minor IS NOT NULL AND threshold_minor>=0) OR(mode='clear' AND threshold_minor IS NULL)),
 UNIQUE(org_id,ownership_id,principal_id,currency,revision_no),
 FOREIGN KEY(org_id,ownership_id) REFERENCES public.property_owners(org_id,id) ON DELETE CASCADE
);
CREATE TABLE app.b013_policy_commands(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 environment text NOT NULL CHECK(environment IN('live','sandbox')),
 currency char(3) NOT NULL REFERENCES public.currencies(code),
 scope_kind text NOT NULL CHECK(scope_kind IN('default','override')),
 requested_ownership_id uuid,
 requested_property_id uuid NOT NULL,
 live_org_id uuid NOT NULL,
 command_kind text NOT NULL CHECK(command_kind IN('set','clear','close')),
 payload_sha256 text,
 outcome text NOT NULL CHECK(outcome IN('changed','no_change','cancelled','rejected_conflict','rejected_disabled','rejected_invalid','rejected_unavailable')),
 result_revision uuid,
 result_audit_id bigint,
 session_id uuid NOT NULL,
 actor_kind text NOT NULL DEFAULT 'owner' CHECK(actor_kind='owner'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,actor_id,request_id),
 CHECK((scope_kind='default' AND requested_ownership_id IS NULL) OR(scope_kind='override' AND requested_ownership_id IS NOT NULL)),
 CHECK((command_kind='close' AND payload_sha256 IS NULL AND outcome='cancelled' AND result_revision IS NULL)
  OR(command_kind<>'close' AND payload_sha256 IS NOT NULL AND payload_sha256 ~ '^[0-9a-f]{64}$' AND outcome<>'cancelled')),
 CHECK(outcome<>'changed' OR(result_revision IS NOT NULL AND result_audit_id IS NOT NULL))
);
REVOKE ALL ON app.b013_regional_defaults,app.b013_default_roots,app.b013_default_revisions,app.b013_override_revisions,app.b013_policy_commands FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b013_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Repair policy history is immutable' USING ERRCODE='23514';END $$;
CREATE TRIGGER b013_default_revision_immutable BEFORE UPDATE ON app.b013_default_revisions FOR EACH ROW EXECUTE FUNCTION app.b013_revision_immutable();
CREATE TRIGGER b013_override_revision_immutable BEFORE UPDATE ON app.b013_override_revisions FOR EACH ROW EXECUTE FUNCTION app.b013_revision_immutable();
CREATE TRIGGER b013_policy_command_immutable BEFORE UPDATE ON app.b013_policy_commands FOR EACH ROW EXECUTE FUNCTION app.b013_revision_immutable();
REVOKE ALL ON FUNCTION app.b013_revision_immutable() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b013_local_day(p_zone text) RETURNS date LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_zone)
  THEN (clock_timestamp() AT TIME ZONE p_zone)::date ELSE NULL END
$$;
REVOKE ALL ON FUNCTION app.b013_local_day(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b013_owner_context(p_org uuid,p_live uuid,p_env text,p_session uuid,p_property uuid)
RETURNS TABLE(principal_id uuid,contact_id uuid,ownership_id uuid,currency text,minor_unit integer,org_country text,org_zone text,enabled boolean,active_property boolean,legacy_override text,source_row_version bigint,source_row_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
DECLARE actor uuid:=auth.uid();o record;c record;p record;po record;chosen record;
 v_day date;v_count integer:=0;v_active integer:=0;v_rows integer;v_audit bigint;v_hash text;v_enabled boolean;v_scale integer;
BEGIN
 -- Session relation admission is needed to authenticate, but no business-row
 -- pins or private relation access precede this fresh session check. RECORD
 -- declarations avoid table-type resolution before these runtime admissions.
 IF actor IS NULL OR p_env IS NULL OR p_env NOT IN('live','sandbox') THEN
  RAISE EXCEPTION 'Repair policy unavailable' USING ERRCODE='42501';END IF;
 LOCK TABLE public.auth_sessions IN ACCESS SHARE MODE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'Repair policy unavailable' USING ERRCODE='42501';END IF;
 LOCK TABLE public.organizations,public.contacts,public.properties,public.property_owners IN ACCESS SHARE MODE NOWAIT;
 IF NOT EXISTS(
  SELECT 1 FROM public.organizations selected JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  JOIN public.auth_sessions s ON s.id=p_session AND s.user_id=actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
  JOIN public.contacts ct ON ct.org_id=selected.id AND ct.user_id=actor AND ct.is_owner AND ct.archived_at IS NULL
  JOIN public.properties pr ON pr.org_id=selected.id AND pr.id=p_property
  JOIN public.property_owners own ON own.org_id=selected.id AND own.property_id=pr.id AND own.owner_contact_id=ct.id
  WHERE selected.id=p_org AND selected.environment::text=p_env AND
   ((p_env='live' AND selected.id=p_live AND selected.live_org_id IS NULL) OR(p_env='sandbox' AND selected.live_org_id=p_live))
   AND own.effective_from<=app.b013_local_day(selected.timezone) AND(own.effective_to IS NULL OR own.effective_to>app.b013_local_day(selected.timezone))
 ) THEN RAISE EXCEPTION 'Repair policy unavailable' USING ERRCODE='42501';END IF;
 LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
 PERFORM 1 FROM public.organizations x WHERE x.id IN(p_org,p_live) ORDER BY x.id FOR SHARE NOWAIT;
 GET DIAGNOSTICS v_rows=ROW_COUNT;
 IF v_rows<>(CASE WHEN p_org=p_live THEN 1 ELSE 2 END) THEN RAISE EXCEPTION 'Repair policy unavailable' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organizations live WHERE live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL) THEN
  RAISE EXCEPTION 'Repair policy unavailable' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Repair policy unavailable' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM auth.users u WHERE u.id=actor FOR KEY SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Repair policy unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM public.organizations x WHERE x.id=p_org AND x.environment::text=p_env AND
  ((p_env='live' AND x.id=p_live AND x.live_org_id IS NULL) OR(p_env='sandbox' AND x.live_org_id=p_live));
 IF NOT FOUND THEN RAISE EXCEPTION 'Repair policy unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM public.properties x WHERE x.org_id=p_org AND x.id=p_property FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Repair policy unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.contacts x WHERE x.org_id=p_org AND x.user_id=actor AND x.is_owner AND x.archived_at IS NULL FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Repair policy unavailable' USING ERRCODE='42501';END IF;
 -- Both parents are pinned: INSERT and owner-ID moves cannot add a new
 -- matching relation. Pin ALL dates, so ended/future→current is not a phantom.
 FOR po IN SELECT x.* FROM public.property_owners x WHERE x.org_id=p_org AND x.property_id=p_property AND x.owner_contact_id=c.id ORDER BY x.id LIMIT 257 FOR SHARE NOWAIT LOOP
  v_count:=v_count+1;
  IF v_count>256 THEN RAISE EXCEPTION 'Repair ownership cohort unsupported' USING ERRCODE='54000';END IF;
 END LOOP;
 v_day:=app.b013_local_day(o.timezone);
 SELECT count(*) INTO v_active FROM public.property_owners x WHERE x.org_id=p_org AND x.property_id=p_property AND x.owner_contact_id=c.id
  AND x.effective_from<=v_day AND(x.effective_to IS NULL OR x.effective_to>v_day);
 IF v_active<>1 THEN RAISE EXCEPTION 'Repair ownership unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO chosen FROM public.property_owners x WHERE x.org_id=p_org AND x.property_id=p_property AND x.owner_contact_id=c.id
  AND x.effective_from<=v_day AND(x.effective_to IS NULL OR x.effective_to>v_day);
 LOCK TABLE public.audit_log IN ACCESS SHARE MODE NOWAIT;
 SELECT max(a.id) INTO v_audit FROM public.audit_log a WHERE a.org_id=p_org AND a.table_name='property_owners' AND a.row_id=chosen.id::text;
 v_audit:=coalesce(v_audit,0);
 SELECT cu.minor_unit INTO v_scale FROM public.currencies cu WHERE cu.code=p.currency FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Repair currency unavailable' USING ERRCODE='42501';END IF;
 v_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_array(chosen.id,chosen.org_id,chosen.property_id,chosen.owner_contact_id,chosen.repair_approval_threshold_minor::text,
  chosen.effective_from,chosen.effective_to,v_audit,c.user_id,c.is_owner,extract(epoch FROM c.archived_at),extract(epoch FROM p.archived_at),trim(p.currency),v_scale,o.country_code,o.timezone)::text,'UTF8')),'hex');
 SELECT coalesce(o.feature_flags->'repair_approvals'='true'::jsonb AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
  AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text),false) INTO v_enabled FROM public.platform_settings f WHERE f.key='repair_approvals';
 IF NOT EXISTS(SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
  OR NOT(chosen.effective_from<=app.b013_local_day(o.timezone) AND(chosen.effective_to IS NULL OR chosen.effective_to>app.b013_local_day(o.timezone))) THEN
  RAISE EXCEPTION 'Repair policy unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT actor,c.id,chosen.id,trim(p.currency),v_scale,o.country_code::text,o.timezone,coalesce(v_enabled,false),p.archived_at IS NULL,chosen.repair_approval_threshold_minor::text,v_audit,v_hash;
END $$;
REVOKE ALL ON FUNCTION app.b013_owner_context(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Owner read gateway. Staff/override/estimate/approval/dispatch remain absent.
CREATE FUNCTION app.b013_owner_view(p_org uuid,p_live uuid,p_env text,p_session uuid,p_property uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
DECLARE ctx record;final_ctx record;root record;rev record;ov record;region record;
 default_value text;default_source text;effective_value text;effective_source text;verified boolean:=false;snapshot text;result jsonb;
BEGIN
 SELECT * INTO ctx FROM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
 IF NOT ctx.active_property THEN RETURN jsonb_build_object('state','recovery_only');END IF;
 IF NOT ctx.enabled THEN RETURN jsonb_build_object('state','disabled');END IF;
 LOCK TABLE app.b013_default_roots,app.b013_default_revisions,app.b013_override_revisions IN ACCESS SHARE MODE NOWAIT;
 SELECT NULL::uuid AS id,NULL::text AS mode,NULL::smallint AS minor_unit,NULL::bigint AS threshold_minor INTO rev;
 SELECT NULL::uuid AS id INTO ov;
 SELECT NULL::uuid AS revision INTO region;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('b013/default/'||p_org::text||'/'||ctx.principal_id::text||'/'||ctx.currency,0)) THEN
  RAISE EXCEPTION 'Repair policy busy' USING ERRCODE='55P03';END IF;
 LOCK TABLE app.b013_regional_defaults IN SHARE MODE NOWAIT;
 SELECT * INTO root FROM app.b013_default_roots x WHERE x.org_id=p_org AND x.principal_id=ctx.principal_id AND x.currency=ctx.currency::char(3) FOR SHARE NOWAIT;
 IF FOUND AND root.version>0 THEN
  SELECT * INTO STRICT rev FROM app.b013_default_revisions x WHERE x.org_id=p_org AND x.root_id=root.id AND x.id=root.current_revision AND x.revision_no=root.version;
  IF rev.mode='set' THEN
   IF rev.minor_unit=ctx.minor_unit THEN default_value:=rev.threshold_minor::text;default_source:='owner_default';
   ELSE default_source:='owner_default_confirmation_required';END IF;
  END IF;
 END IF;
 IF default_value IS NULL AND default_source IS NULL THEN
  SELECT * INTO region FROM app.b013_regional_defaults x WHERE x.country_code=ctx.org_country AND x.currency=ctx.currency::char(3);
  IF FOUND AND region.minor_unit=ctx.minor_unit THEN default_value:=region.threshold_minor::text;default_source:='regional_default';ELSE default_source:='configuration_required';END IF;
 END IF;
 IF ctx.legacy_override IS NOT NULL THEN
  SELECT * INTO ov FROM app.b013_override_revisions x WHERE x.org_id=p_org AND x.ownership_id=ctx.ownership_id AND x.principal_id=ctx.principal_id AND x.currency=ctx.currency::char(3) ORDER BY x.revision_no DESC LIMIT 1;
  IF FOUND AND ov.mode='set' AND ov.minor_unit=ctx.minor_unit AND ov.threshold_minor::text=ctx.legacy_override AND ov.source_row_version=ctx.source_row_version AND ov.source_row_hash=ctx.source_row_hash THEN
   effective_value:=ctx.legacy_override;effective_source:='property_override';verified:=true;
  ELSE effective_source:='legacy_confirmation_required';END IF;
 ELSE effective_value:=default_value;effective_source:=default_source;verified:=default_value IS NOT NULL;
 END IF;
 snapshot:=encode(pg_catalog.sha256(convert_to(jsonb_build_array(ctx.source_row_hash,ctx.source_row_version,root.id,root.version,rev.id,region.revision,default_value,default_source,ov.id,effective_value,effective_source)::text,'UTF8')),'hex');
 result:=jsonb_build_object('state','enabled','propertyId',p_property,'ownershipId',ctx.ownership_id,'currency',ctx.currency,'minorUnit',ctx.minor_unit,
  'defaultMinor',default_value,'defaultSource',default_source,'overrideMinor',ctx.legacy_override,'effectiveMinor',effective_value,'effectiveSource',effective_source,'verified',verified,'snapshot',snapshot);
 SELECT * INTO final_ctx FROM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
 IF final_ctx.source_row_hash IS DISTINCT FROM ctx.source_row_hash OR final_ctx.ownership_id IS DISTINCT FROM ctx.ownership_id OR NOT final_ctx.enabled THEN
  RAISE EXCEPTION 'Repair policy source changed' USING ERRCODE='40001';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b013_owner_view(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_owner_view(uuid,uuid,text,uuid,uuid) TO service_role;

-- Personal-default commands only. The fixed application wrapper, not arbitrary
-- service-role SQL, is the supported transaction protocol.
CREATE FUNCTION app.b013_default_request_lock(p_org uuid,p_request uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF p_request IS NULL THEN RAISE EXCEPTION 'Invalid repair request' USING ERRCODE='22023';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('b013/request/'||p_org::text||'/'||auth.uid()::text||'/'||p_request::text,0)) THEN
  RAISE EXCEPTION 'Repair policy request busy' USING ERRCODE='55P03';END IF;
END $$;
REVOKE ALL ON FUNCTION app.b013_default_request_lock(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b013_default_result(p_org uuid,p_live uuid,p_env text,p_property uuid,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE cmd record;
BEGIN
 LOCK TABLE app.b013_policy_commands IN ACCESS SHARE MODE NOWAIT;
 SELECT * INTO cmd FROM app.b013_policy_commands x WHERE x.org_id=p_org AND x.actor_id=auth.uid() AND x.request_id=p_request;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','unknown');END IF;
 IF cmd.scope_kind<>'default' OR cmd.requested_property_id IS DISTINCT FROM p_property OR cmd.environment IS DISTINCT FROM p_env OR cmd.live_org_id IS DISTINCT FROM p_live THEN
  RAISE EXCEPTION 'Repair request identity mismatch' USING ERRCODE='23514',CONSTRAINT='b013_request_identity';END IF;
 RETURN jsonb_build_object('status','recorded','request_id',cmd.request_id,'outcome',cmd.outcome,'recorded_at',cmd.recorded_at);
END $$;
REVOKE ALL ON FUNCTION app.b013_default_result(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b013_change_default(p_org uuid,p_live uuid,p_env text,p_session uuid,p_property uuid,p_request uuid,p_expected text,p_action text,p_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
DECLARE ctx record;cmd record;root record;rev record;
 v_hash text;v_outcome text;v_value bigint;v_revision uuid;v_audit bigint;v_view jsonb;
BEGIN
 -- Malformed envelopes are not a different recorded command kind.
 IF p_request IS NULL OR p_expected IS NULL OR p_expected !~ '^[0-9a-f]{64}$' OR p_action IS NULL OR p_action NOT IN('set','clear') OR p_value IS NULL OR length(p_value)>64 THEN
  RAISE EXCEPTION 'Invalid repair policy command' USING ERRCODE='22023';END IF;
 SELECT * INTO ctx FROM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
 LOCK TABLE app.b013_policy_commands IN ROW EXCLUSIVE MODE NOWAIT;
 PERFORM app.b013_default_request_lock(p_org,p_request);
 v_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_array(p_property,p_expected,p_action,p_value)::text,'UTF8')),'hex');
 SELECT * INTO cmd FROM app.b013_policy_commands x WHERE x.org_id=p_org AND x.actor_id=ctx.principal_id AND x.request_id=p_request;
 IF FOUND THEN
  PERFORM app.b013_default_result(p_org,p_live,p_env,p_property,p_request);
  IF cmd.command_kind<>'close' AND(cmd.command_kind<>p_action OR cmd.payload_sha256 IS DISTINCT FROM v_hash) THEN
   RAISE EXCEPTION 'Repair request identity mismatch' USING ERRCODE='23514',CONSTRAINT='b013_request_identity';END IF;
  RETURN app.b013_default_result(p_org,p_live,p_env,p_property,p_request);
 END IF;
 IF NOT ctx.active_property THEN v_outcome:='rejected_unavailable';
 ELSIF NOT ctx.enabled THEN v_outcome:='rejected_disabled';
 ELSE
  LOCK TABLE app.b013_default_roots,app.b013_default_revisions IN ROW EXCLUSIVE MODE NOWAIT;
  SELECT NULL::text AS mode,NULL::bigint AS threshold_minor,NULL::smallint AS minor_unit INTO rev;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('b013/default/'||p_org::text||'/'||ctx.principal_id::text||'/'||ctx.currency,0)) THEN
   RAISE EXCEPTION 'Repair policy busy' USING ERRCODE='55P03';END IF;
  v_view:=app.b013_owner_view(p_org,p_live,p_env,p_session,p_property);
  IF v_view->>'snapshot' IS DISTINCT FROM p_expected THEN v_outcome:='rejected_conflict';
  ELSIF (p_action='clear' AND p_value<>'') OR(p_action='set' AND(p_value !~ '^(0|[1-9][0-9]*)$' OR length(p_value)>19)) THEN v_outcome:='rejected_invalid';
  ELSIF (CASE WHEN p_action='set' THEN p_value::numeric>9223372036854775807::numeric ELSE false END) THEN v_outcome:='rejected_invalid';
  ELSE
   IF p_action='set' THEN v_value:=p_value::bigint;END IF;
   SELECT * INTO root FROM app.b013_default_roots x WHERE x.org_id=p_org AND x.principal_id=ctx.principal_id AND x.currency=ctx.currency::char(3) FOR UPDATE NOWAIT;
   IF FOUND AND root.version>0 THEN SELECT * INTO STRICT rev FROM app.b013_default_revisions x WHERE x.org_id=p_org AND x.root_id=root.id AND x.id=root.current_revision AND x.revision_no=root.version;END IF;
   IF(p_action='clear' AND(root.id IS NULL OR root.version=0 OR rev.mode='clear')) OR(p_action='set' AND rev.mode='set' AND rev.threshold_minor=v_value AND rev.minor_unit=ctx.minor_unit) THEN
    v_outcome:='no_change';
   ELSE
    LOCK TABLE public.audit_log IN ROW EXCLUSIVE MODE NOWAIT;
    IF root.id IS NULL THEN INSERT INTO app.b013_default_roots(org_id,principal_id,currency) VALUES(p_org,ctx.principal_id,ctx.currency::char(3)) RETURNING * INTO root;END IF;
    v_revision:=gen_random_uuid();
    INSERT INTO app.b013_default_revisions(id,org_id,root_id,principal_id,currency,minor_unit,revision_no,mode,threshold_minor,actor_id,session_id,request_id)
     VALUES(v_revision,p_org,root.id,ctx.principal_id,ctx.currency::char(3),ctx.minor_unit,root.version+1,p_action,v_value,ctx.principal_id,p_session,p_request);
    UPDATE app.b013_default_roots SET version=root.version+1,current_revision=v_revision WHERE id=root.id AND org_id=p_org;
    INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,new_row,reason,request_id,occurred_at)
     VALUES(p_org,ctx.principal_id,'owner','b013_default_revisions',v_revision::text,'insert',
      jsonb_build_object('root_id',root.id,'revision_id',v_revision,'revision_no',root.version+1,'mode',p_action,'threshold_minor',v_value::text,'currency',ctx.currency,'minor_unit',ctx.minor_unit,'authorization_property_id',p_property),
      'owner_repair_default_changed',p_request::text,clock_timestamp()) RETURNING id INTO v_audit;
    v_outcome:='changed';
   END IF;
  END IF;
 END IF;
 INSERT INTO app.b013_policy_commands(org_id,actor_id,request_id,environment,currency,scope_kind,requested_property_id,live_org_id,command_kind,payload_sha256,outcome,result_revision,result_audit_id,session_id)
  VALUES(p_org,ctx.principal_id,p_request,p_env,ctx.currency::char(3),'default',p_property,p_live,p_action,v_hash,v_outcome,v_revision,v_audit,p_session);
 RETURN app.b013_default_result(p_org,p_live,p_env,p_property,p_request);
END $$;
REVOKE ALL ON FUNCTION app.b013_change_default(uuid,uuid,text,uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_change_default(uuid,uuid,text,uuid,uuid,uuid,text,text,text) TO service_role;

CREATE FUNCTION app.b013_default_status(p_org uuid,p_live uuid,p_env text,p_session uuid,p_property uuid,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
BEGIN
 PERFORM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
 LOCK TABLE app.b013_policy_commands IN ACCESS SHARE MODE NOWAIT;
 PERFORM app.b013_default_request_lock(p_org,p_request);
 RETURN app.b013_default_result(p_org,p_live,p_env,p_property,p_request);
END $$;
REVOKE ALL ON FUNCTION app.b013_default_status(uuid,uuid,text,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_default_status(uuid,uuid,text,uuid,uuid,uuid) TO service_role;

CREATE FUNCTION app.b013_close_default(p_org uuid,p_live uuid,p_env text,p_session uuid,p_property uuid,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
DECLARE ctx record;result jsonb;
BEGIN
 SELECT * INTO ctx FROM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
 LOCK TABLE app.b013_policy_commands IN ROW EXCLUSIVE MODE NOWAIT;
 PERFORM app.b013_default_request_lock(p_org,p_request);
 result:=app.b013_default_result(p_org,p_live,p_env,p_property,p_request);
 IF result->>'status'='recorded' THEN RETURN result;END IF;
 INSERT INTO app.b013_policy_commands(org_id,actor_id,request_id,environment,currency,scope_kind,requested_property_id,live_org_id,command_kind,outcome,session_id)
  VALUES(p_org,ctx.principal_id,p_request,p_env,ctx.currency::char(3),'default',p_property,p_live,'close','cancelled',p_session);
 RETURN app.b013_default_result(p_org,p_live,p_env,p_property,p_request);
END $$;
REVOKE ALL ON FUNCTION app.b013_close_default(uuid,uuid,text,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_close_default(uuid,uuid,text,uuid,uuid,uuid) TO service_role;

CREATE FUNCTION app.b013_finish_default(p_org uuid,p_live uuid,p_env text,p_session uuid,p_property uuid,p_request uuid,p_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
DECLARE ctx record;final_ctx record;cmd record;v_fresh boolean:=false;result jsonb;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN('change','status','close') THEN RAISE EXCEPTION 'Invalid repair command mode' USING ERRCODE='22023';END IF;
 SELECT * INTO ctx FROM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
 LOCK TABLE app.b013_policy_commands IN ACCESS SHARE MODE NOWAIT;
 SELECT NULL::text AS outcome INTO cmd;
 PERFORM app.b013_default_request_lock(p_org,p_request);
 result:=app.b013_default_result(p_org,p_live,p_env,p_property,p_request);
 IF result->>'status'='recorded' THEN
 SELECT * INTO cmd FROM app.b013_policy_commands x WHERE x.org_id=p_org AND x.actor_id=ctx.principal_id AND x.request_id=p_request;
 SELECT x.xmin::text::bigint=(pg_current_xact_id()::text::numeric%4294967296)::bigint INTO v_fresh FROM app.b013_policy_commands x WHERE x.id=cmd.id;
 IF v_fresh AND cmd.outcome='changed' THEN
  LOCK TABLE app.b013_default_roots,app.b013_default_revisions,public.audit_log IN ACCESS SHARE MODE NOWAIT;
  IF p_mode<>'change' OR NOT ctx.enabled OR NOT ctx.active_property OR cmd.session_id IS DISTINCT FROM p_session OR cmd.currency::text IS DISTINCT FROM ctx.currency OR NOT EXISTS(
   SELECT 1 FROM app.b013_default_roots r JOIN app.b013_default_revisions v ON v.org_id=r.org_id AND v.root_id=r.id AND v.id=r.current_revision AND v.revision_no=r.version
    WHERE r.org_id=p_org AND r.principal_id=ctx.principal_id AND r.currency=cmd.currency AND v.id=cmd.result_revision AND v.principal_id=ctx.principal_id
     AND v.actor_id=ctx.principal_id AND v.session_id=p_session AND v.request_id=p_request AND v.mode=cmd.command_kind AND v.minor_unit=ctx.minor_unit
  ) OR NOT EXISTS(SELECT 1 FROM public.audit_log a WHERE a.id=cmd.result_audit_id AND a.org_id=p_org AND a.actor_user_id=ctx.principal_id AND a.actor_role='owner'
   AND a.table_name='b013_default_revisions' AND a.row_id=cmd.result_revision::text AND a.action='insert' AND a.request_id=p_request::text AND a.reason='owner_repair_default_changed') THEN RAISE EXCEPTION 'Repair command final validation failed' USING ERRCODE='40001';END IF;
 END IF;
 END IF;
 -- Last business validation after all command/revision/audit reads, including
 -- an absent request. The fixed wrapper immediately awaits COMMIT afterward.
 SELECT * INTO final_ctx FROM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
 IF v_fresh AND cmd.outcome='changed' AND(NOT final_ctx.enabled OR NOT final_ctx.active_property OR final_ctx.source_row_hash IS DISTINCT FROM ctx.source_row_hash) THEN
  RAISE EXCEPTION 'Repair command final source changed' USING ERRCODE='40001';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b013_finish_default(uuid,uuid,text,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_finish_default(uuid,uuid,text,uuid,uuid,uuid,text) TO service_role;
COMMIT;
