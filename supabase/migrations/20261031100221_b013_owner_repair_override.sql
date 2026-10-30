-- Unpublished B013/B021 property-override continuation. Existing public column
-- remains sole mutable value; no estimate approval or dispatch is enabled.
BEGIN;
CREATE FUNCTION app.b013_override_result(p_org uuid,p_live uuid,p_env text,p_property uuid,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE cmd record;
BEGIN
 LOCK TABLE app.b013_policy_commands IN ACCESS SHARE MODE NOWAIT;
 SELECT * INTO cmd FROM app.b013_policy_commands x WHERE x.org_id=p_org AND x.actor_id=auth.uid() AND x.request_id=p_request;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','unknown');END IF;
 IF cmd.scope_kind<>'override' OR cmd.requested_property_id IS DISTINCT FROM p_property OR cmd.environment IS DISTINCT FROM p_env OR cmd.live_org_id IS DISTINCT FROM p_live THEN
  RAISE EXCEPTION 'Repair request identity mismatch' USING ERRCODE='23514',CONSTRAINT='b013_request_identity';END IF;
 RETURN jsonb_build_object('status','recorded','request_id',cmd.request_id,'outcome',cmd.outcome,'recorded_at',cmd.recorded_at);
END $$;
REVOKE ALL ON FUNCTION app.b013_override_result(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b013_change_override(p_org uuid,p_live uuid,p_env text,p_session uuid,p_property uuid,p_request uuid,p_expected text,p_action text,p_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
DECLARE ctx record;after_ctx record;cmd record;locked_row record;v_view jsonb;
 v_hash text;v_outcome text;v_value bigint;v_revision uuid;v_audit bigint;v_number bigint;v_changed boolean:=false;
 v_old_request text;v_old_reason text;v_rows integer;
BEGIN
 IF p_request IS NULL OR p_expected IS NULL OR p_expected !~ '^[0-9a-f]{64}$' OR p_action IS NULL OR p_action NOT IN('set','clear') OR p_value IS NULL OR length(p_value)>64 THEN
  RAISE EXCEPTION 'Invalid repair policy command' USING ERRCODE='22023';END IF;
 SELECT * INTO ctx FROM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
 LOCK TABLE app.b013_policy_commands IN ROW EXCLUSIVE MODE NOWAIT;
 PERFORM app.b013_default_request_lock(p_org,p_request);
 v_hash:=encode(public.digest(jsonb_build_array('override',p_property,p_expected,p_action,p_value)::text,'sha256'),'hex');
 SELECT * INTO cmd FROM app.b013_policy_commands x WHERE x.org_id=p_org AND x.actor_id=ctx.principal_id AND x.request_id=p_request;
 IF FOUND THEN
  PERFORM app.b013_override_result(p_org,p_live,p_env,p_property,p_request);
  IF cmd.command_kind<>'close' AND(cmd.command_kind<>p_action OR cmd.payload_sha256 IS DISTINCT FROM v_hash) THEN
   RAISE EXCEPTION 'Repair request identity mismatch' USING ERRCODE='23514',CONSTRAINT='b013_request_identity';END IF;
  RETURN app.b013_override_result(p_org,p_live,p_env,p_property,p_request);
 END IF;
 IF NOT ctx.active_property THEN v_outcome:='rejected_unavailable';
 ELSIF NOT ctx.enabled THEN v_outcome:='rejected_disabled';
 ELSE
  LOCK TABLE public.property_owners,app.b013_override_revisions,public.audit_log IN ROW EXCLUSIVE MODE NOWAIT;
  -- Existing owner_view pins the personal default/inheritance absence and the
  -- regional source. It does not turn legacy integers into verified currency.
  v_view:=app.b013_owner_view(p_org,p_live,p_env,p_session,p_property);
  IF v_view->>'snapshot' IS DISTINCT FROM p_expected THEN v_outcome:='rejected_conflict';
  ELSIF(p_action='clear' AND p_value<>'') OR(p_action='set' AND(p_value !~ '^(0|[1-9][0-9]*)$' OR length(p_value)>19)) THEN v_outcome:='rejected_invalid';
  ELSIF(CASE WHEN p_action='set' THEN p_value::numeric>9223372036854775807::numeric ELSE false END) THEN v_outcome:='rejected_invalid';
  ELSE
   IF p_action='set' THEN v_value:=p_value::bigint;END IF;
   SELECT * INTO locked_row FROM public.property_owners x WHERE x.org_id=p_org AND x.id=ctx.ownership_id FOR UPDATE NOWAIT;
   IF NOT FOUND OR locked_row.property_id IS DISTINCT FROM p_property OR locked_row.owner_contact_id IS DISTINCT FROM ctx.contact_id THEN
    RAISE EXCEPTION 'Repair ownership changed' USING ERRCODE='40001';END IF;
   SELECT * INTO after_ctx FROM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
   IF after_ctx.source_row_hash IS DISTINCT FROM ctx.source_row_hash OR after_ctx.ownership_id IS DISTINCT FROM ctx.ownership_id THEN
    RAISE EXCEPTION 'Repair policy source changed' USING ERRCODE='40001';END IF;
   IF(p_action='clear' AND ctx.legacy_override IS NULL) OR(p_action='set' AND ctx.legacy_override=v_value::text AND v_view->>'effectiveSource'='property_override' AND v_view->'verified'='true'::jsonb) THEN
    v_outcome:='no_change';
   ELSE
    v_changed:=ctx.legacy_override IS DISTINCT FROM v_value::text;
    IF v_changed THEN
     v_old_request:=current_setting('app.request_id',true);v_old_reason:=current_setting('app.change_reason',true);
     PERFORM set_config('app.request_id',p_request::text,true),set_config('app.change_reason','owner_repair_override_value',true);
     UPDATE public.property_owners SET repair_approval_threshold_minor=v_value WHERE org_id=p_org AND id=ctx.ownership_id;
     GET DIAGNOSTICS v_rows=ROW_COUNT;
     IF v_rows<>1 THEN RAISE EXCEPTION 'Repair ownership unavailable' USING ERRCODE='42501';END IF;
     PERFORM set_config('app.request_id',coalesce(v_old_request,''),true),set_config('app.change_reason',coalesce(v_old_reason,''),true);
    END IF;
    SELECT * INTO after_ctx FROM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
    IF after_ctx.ownership_id IS DISTINCT FROM ctx.ownership_id OR after_ctx.principal_id IS DISTINCT FROM ctx.principal_id OR after_ctx.currency IS DISTINCT FROM ctx.currency
     OR after_ctx.minor_unit IS DISTINCT FROM ctx.minor_unit OR after_ctx.legacy_override IS DISTINCT FROM v_value::text THEN
     RAISE EXCEPTION 'Repair override source changed' USING ERRCODE='40001';END IF;
    SELECT coalesce(max(x.revision_no),0)+1 INTO v_number FROM app.b013_override_revisions x WHERE x.org_id=p_org AND x.ownership_id=ctx.ownership_id AND x.principal_id=ctx.principal_id AND x.currency=ctx.currency::char(3);
    v_revision:=gen_random_uuid();
    INSERT INTO app.b013_override_revisions(id,org_id,ownership_id,principal_id,currency,minor_unit,revision_no,mode,threshold_minor,source_row_version,source_row_hash,actor_id,session_id,request_id)
     VALUES(v_revision,p_org,ctx.ownership_id,ctx.principal_id,ctx.currency::char(3),ctx.minor_unit,v_number,p_action,v_value,after_ctx.source_row_version,after_ctx.source_row_hash,ctx.principal_id,p_session,p_request);
    -- Distinct event identity: a confirmation must not change the public
    -- property_owners audit maximum after its source version was captured.
    INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,new_row,reason,request_id,occurred_at)
     VALUES(p_org,ctx.principal_id,'owner','b013_override_revisions',v_revision::text,'insert',jsonb_build_object('revision_id',v_revision,'revision_no',v_number,
      'ownership_id',ctx.ownership_id,'property_id',p_property,'mode',p_action,'threshold_minor',v_value::text,'currency',ctx.currency,'minor_unit',ctx.minor_unit,
      'source_row_version',after_ctx.source_row_version,'source_row_hash',after_ctx.source_row_hash,'public_value_changed',v_changed),
      'owner_repair_override_revision',p_request::text,clock_timestamp()) RETURNING id INTO v_audit;
    v_outcome:='changed';
   END IF;
  END IF;
 END IF;
 INSERT INTO app.b013_policy_commands(org_id,actor_id,request_id,environment,currency,scope_kind,requested_ownership_id,requested_property_id,live_org_id,command_kind,payload_sha256,outcome,result_revision,result_audit_id,session_id)
  VALUES(p_org,ctx.principal_id,p_request,p_env,ctx.currency::char(3),'override',ctx.ownership_id,p_property,p_live,p_action,v_hash,v_outcome,v_revision,v_audit,p_session);
 RETURN app.b013_override_result(p_org,p_live,p_env,p_property,p_request);
END $$;
REVOKE ALL ON FUNCTION app.b013_change_override(uuid,uuid,text,uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_change_override(uuid,uuid,text,uuid,uuid,uuid,text,text,text) TO service_role;

CREATE FUNCTION app.b013_override_status(p_org uuid,p_live uuid,p_env text,p_session uuid,p_property uuid,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
BEGIN
 PERFORM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
 LOCK TABLE app.b013_policy_commands IN ACCESS SHARE MODE NOWAIT;
 PERFORM app.b013_default_request_lock(p_org,p_request);
 RETURN app.b013_override_result(p_org,p_live,p_env,p_property,p_request);
END $$;
REVOKE ALL ON FUNCTION app.b013_override_status(uuid,uuid,text,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_override_status(uuid,uuid,text,uuid,uuid,uuid) TO service_role;

CREATE FUNCTION app.b013_close_override(p_org uuid,p_live uuid,p_env text,p_session uuid,p_property uuid,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
DECLARE ctx record;result jsonb;
BEGIN
 SELECT * INTO ctx FROM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
 LOCK TABLE app.b013_policy_commands IN ROW EXCLUSIVE MODE NOWAIT;
 PERFORM app.b013_default_request_lock(p_org,p_request);
 result:=app.b013_override_result(p_org,p_live,p_env,p_property,p_request);
 IF result->>'status'='recorded' THEN RETURN result;END IF;
 INSERT INTO app.b013_policy_commands(org_id,actor_id,request_id,environment,currency,scope_kind,requested_ownership_id,requested_property_id,live_org_id,command_kind,outcome,session_id)
  VALUES(p_org,ctx.principal_id,p_request,p_env,ctx.currency::char(3),'override',ctx.ownership_id,p_property,p_live,'close','cancelled',p_session);
 RETURN app.b013_override_result(p_org,p_live,p_env,p_property,p_request);
END $$;
REVOKE ALL ON FUNCTION app.b013_close_override(uuid,uuid,text,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_close_override(uuid,uuid,text,uuid,uuid,uuid) TO service_role;

CREATE FUNCTION app.b013_finish_override(p_org uuid,p_live uuid,p_env text,p_session uuid,p_property uuid,p_request uuid,p_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
DECLARE ctx record;final_ctx record;cmd record;v_fresh boolean:=false;result jsonb;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN('change','status','close') THEN RAISE EXCEPTION 'Invalid repair command mode' USING ERRCODE='22023';END IF;
 SELECT * INTO ctx FROM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
 LOCK TABLE app.b013_policy_commands IN ACCESS SHARE MODE NOWAIT;
 SELECT NULL::text AS outcome INTO cmd;
 PERFORM app.b013_default_request_lock(p_org,p_request);
 result:=app.b013_override_result(p_org,p_live,p_env,p_property,p_request);
 IF result->>'status'='recorded' THEN
  SELECT * INTO cmd FROM app.b013_policy_commands x WHERE x.org_id=p_org AND x.actor_id=ctx.principal_id AND x.request_id=p_request;
  SELECT x.xmin::text::bigint=(pg_current_xact_id()::text::numeric%4294967296)::bigint INTO v_fresh FROM app.b013_policy_commands x WHERE x.id=cmd.id;
  IF v_fresh AND cmd.outcome='changed' THEN
   LOCK TABLE app.b013_override_revisions,public.audit_log IN ACCESS SHARE MODE NOWAIT;
   IF p_mode<>'change' OR NOT ctx.enabled OR NOT ctx.active_property OR cmd.session_id IS DISTINCT FROM p_session OR cmd.requested_ownership_id IS DISTINCT FROM ctx.ownership_id OR cmd.currency::text IS DISTINCT FROM ctx.currency OR NOT EXISTS(
    SELECT 1 FROM app.b013_override_revisions v WHERE v.id=cmd.result_revision AND v.org_id=p_org AND v.ownership_id=ctx.ownership_id AND v.principal_id=ctx.principal_id AND v.currency=cmd.currency
     AND v.actor_id=ctx.principal_id AND v.session_id=p_session AND v.request_id=p_request AND v.mode=cmd.command_kind AND v.minor_unit=ctx.minor_unit
     AND v.threshold_minor::text IS NOT DISTINCT FROM ctx.legacy_override AND v.source_row_version=ctx.source_row_version AND v.source_row_hash=ctx.source_row_hash
     AND v.revision_no=(SELECT max(latest.revision_no) FROM app.b013_override_revisions latest WHERE latest.org_id=p_org AND latest.ownership_id=ctx.ownership_id AND latest.principal_id=ctx.principal_id AND latest.currency=cmd.currency)
   ) OR NOT EXISTS(SELECT 1 FROM public.audit_log a WHERE a.id=cmd.result_audit_id AND a.org_id=p_org AND a.actor_user_id=ctx.principal_id AND a.actor_role='owner' AND a.table_name='b013_override_revisions'
    AND a.row_id=cmd.result_revision::text AND a.action='insert' AND a.request_id=p_request::text AND a.reason='owner_repair_override_revision') THEN
    RAISE EXCEPTION 'Repair override final validation failed' USING ERRCODE='40001';END IF;
  END IF;
 END IF;
 SELECT * INTO final_ctx FROM app.b013_owner_context(p_org,p_live,p_env,p_session,p_property);
 IF v_fresh AND cmd.outcome='changed' AND(NOT final_ctx.enabled OR NOT final_ctx.active_property OR final_ctx.source_row_hash IS DISTINCT FROM ctx.source_row_hash) THEN
  RAISE EXCEPTION 'Repair override final source changed' USING ERRCODE='40001';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b013_finish_override(uuid,uuid,text,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_finish_override(uuid,uuid,text,uuid,uuid,uuid,text) TO service_role;
COMMIT;
