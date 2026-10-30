BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- Draft, local-only command authority. No archive or auth/profile mutation.
INSERT INTO public.platform_settings(key,value,description)
VALUES('tenant_directory_edit','{"enabled":false,"allowed_org_ids":[]}'::jsonb,'Company-local tenant contact directory; default OFF')
ON CONFLICT(key) DO NOTHING;

CREATE TABLE app.b015_edit_commands (
 org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 requested_contact_id uuid NOT NULL,
 scoped_contact_id uuid,
 environment text NOT NULL CHECK(environment IN ('live','sandbox')),
 command_kind text NOT NULL DEFAULT 'edit' CHECK(command_kind IN ('edit','close')),
 payload_sha256 text CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
 result_sha256 text CHECK(result_sha256 ~ '^[0-9a-f]{64}$'),
 actor_role text NOT NULL CHECK(actor_role IN ('admin','manager')),
 session_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('changed','no_change','rejected_invalid','rejected_conflict','rejected_unavailable','rejected_disabled','rejected_email_exists','cancelled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,actor_id,request_id),
 FOREIGN KEY(org_id,scoped_contact_id) REFERENCES public.contacts(org_id,id) ON DELETE CASCADE,
 CHECK(scoped_contact_id IS NULL OR scoped_contact_id=requested_contact_id),
 CHECK((command_kind='edit' AND payload_sha256 IS NOT NULL AND outcome<>'cancelled') OR (command_kind='close' AND payload_sha256 IS NULL AND result_sha256 IS NULL AND outcome='cancelled')),
 CHECK(outcome NOT IN ('changed','no_change') OR (scoped_contact_id IS NOT NULL AND result_sha256 IS NOT NULL))
);
REVOKE ALL ON app.b015_edit_commands FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b015_command_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Immutable directory operation' USING ERRCODE='42501'; END $$;
CREATE TRIGGER b015_command_immutable BEFORE UPDATE ON app.b015_edit_commands
FOR EACH ROW EXECUTE FUNCTION app.b015_command_immutable();
REVOKE ALL ON FUNCTION app.b015_command_immutable() FROM PUBLIC,anon,authenticated,service_role;
-- DELETE has no application grant. Existing authorized parent lifecycle may
-- cascade metadata; no raw contact payload or old/new PII snapshot is copied.

CREATE FUNCTION app.b015_contact_snapshot(p_org uuid,p_contact uuid) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT encode(pg_catalog.sha256(convert_to(jsonb_build_array(c.id,c.org_id,c.user_id,
   c.is_tenant,c.is_owner,c.is_vendor,extract(epoch FROM c.archived_at),c.display_name,c.email::text,c.phone_e164,
   extract(epoch FROM c.updated_at))::text,'UTF8')),'hex')
 FROM public.contacts c WHERE c.org_id=p_org AND c.id=p_contact
$$;
REVOKE ALL ON FUNCTION app.b015_contact_snapshot(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b015_edit_context(p_org uuid,p_live uuid,p_env text,p_session uuid)
RETURNS TABLE(actor_role text,enabled boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE v_actor uuid:=auth.uid(); v_role text; v_count integer; v_expected integer;
BEGIN
 IF v_actor IS NULL OR p_env NOT IN ('live','sandbox') OR NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  JOIN public.org_members m ON m.org_id=live.id AND m.user_id=v_actor AND m.status='active' AND m.role IN ('admin','manager')
  JOIN public.auth_sessions s ON s.id=p_session AND s.user_id=v_actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL) OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'Directory operation unavailable' USING ERRCODE='42501'; END IF;
 LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
 PERFORM 1 FROM public.organizations o WHERE o.id IN(p_org,p_live) ORDER BY o.id FOR SHARE NOWAIT;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 v_expected:=CASE WHEN p_org=p_live THEN 1 ELSE 2 END;
 IF v_count<>v_expected THEN RAISE EXCEPTION 'Directory operation unavailable' USING ERRCODE='42501'; END IF;
 SELECT m.role::text INTO v_role FROM public.org_members m
  WHERE m.org_id=p_live AND m.user_id=v_actor AND m.status='active' AND m.role IN ('admin','manager') FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Directory operation unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=v_actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Directory operation unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM auth.users u WHERE u.id=v_actor FOR KEY SHARE NOWAIT;
 IF NOT FOUND OR NOT EXISTS (
  SELECT 1 FROM public.organizations o JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL) OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'Directory operation unavailable' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT v_role,coalesce((SELECT o.feature_flags->'tenant_directory_edit'='true'::jsonb
   AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
  FROM public.organizations o JOIN public.platform_settings f ON f.key='tenant_directory_edit' WHERE o.id=p_org),false);
 -- Last read of wall-clock authority follows all relationship and flag reads.
 -- This is a validation boundary, not an unforceable durable-commit clock hook.
 IF NOT EXISTS(SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=v_actor
   AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'Directory operation unavailable' USING ERRCODE='42501';
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.b015_edit_context(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b015_edit_commit_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE v_live uuid;
BEGIN
 IF auth.uid() IS DISTINCT FROM NEW.actor_id THEN RAISE EXCEPTION 'Directory operation unavailable' USING ERRCODE='42501'; END IF;
 SELECT CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END INTO v_live FROM public.organizations o WHERE o.id=NEW.org_id;
 PERFORM * FROM app.b015_edit_context(NEW.org_id,v_live,NEW.environment,NEW.session_id);
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER b015_edit_commit_context AFTER INSERT ON app.b015_edit_commands
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b015_edit_commit_context();
REVOKE ALL ON FUNCTION app.b015_edit_commit_context() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b015_edit_status(p_org uuid,p_live uuid,p_env text,p_session uuid,p_contact uuid,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
DECLARE r app.b015_edit_commands;
BEGIN
 PERFORM * FROM app.b015_edit_context(p_org,p_live,p_env,p_session);
 IF p_contact IS NULL OR p_request IS NULL THEN RAISE EXCEPTION 'Directory operation unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM app.b015_edit_commands c WHERE c.org_id=p_org AND c.actor_id=auth.uid() AND c.request_id=p_request;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','unknown'); END IF;
 IF r.requested_contact_id IS DISTINCT FROM p_contact OR r.environment IS DISTINCT FROM p_env THEN
  RAISE EXCEPTION 'Directory request mismatch' USING ERRCODE='23514',CONSTRAINT='b015_request_identity';
 END IF;
 -- Current auth only; no old/current PII or revived contact eligibility.
 RETURN jsonb_build_object('status','recorded','request_id',r.request_id,'outcome',r.outcome,'recorded_at',r.created_at);
END $$;
REVOKE ALL ON FUNCTION app.b015_edit_status(uuid,uuid,text,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b015_edit_status(uuid,uuid,text,uuid,uuid,uuid) TO service_role;

CREATE FUNCTION app.b015_edit_contact(p_org uuid,p_live uuid,p_env text,p_session uuid,p_contact uuid,p_request uuid,p_expected text,p_name text,p_email text,p_phone text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
DECLARE v_actor uuid:=auth.uid(); v_role text; v_enabled boolean; v_name text; v_email text; v_phone text;
 v_hash text; v_snapshot text; v_outcome text; v_scoped uuid; v_constraint text; v_prior_reason text; v_prior_request text; c public.contacts; r app.b015_edit_commands;
BEGIN
 SELECT x.actor_role,x.enabled INTO v_role,v_enabled FROM app.b015_edit_context(p_org,p_live,p_env,p_session) x;
 IF p_contact IS NULL OR p_request IS NULL OR coalesce(length(p_expected),0)>4096 OR coalesce(length(p_name),0)>4096
  OR coalesce(length(p_email),0)>4096 OR coalesce(length(p_phone),0)>4096 THEN
  RAISE EXCEPTION 'Invalid directory operation' USING ERRCODE='22023';
 END IF;
 v_name:=btrim(coalesce(p_name,''),E' \t\r\n');
 v_email:=nullif(lower(btrim(coalesce(p_email,''),E' \t\r\n')),'');
 v_phone:=nullif(btrim(coalesce(p_phone,''),E' \t\r\n'),'');
 v_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_array(p_contact,p_env,lower(coalesce(p_expected,'')),v_name,v_email,v_phone)::text,'UTF8')),'hex');
 IF NOT pg_try_advisory_xact_lock(hashtextextended('b015-edit:'||p_org::text||':'||v_actor::text||':'||p_request::text,0)) THEN
  RAISE EXCEPTION 'Directory operation busy' USING ERRCODE='55P03';
 END IF;
 SELECT * INTO r FROM app.b015_edit_commands x WHERE x.org_id=p_org AND x.actor_id=v_actor AND x.request_id=p_request;
 IF FOUND THEN
  IF r.requested_contact_id IS DISTINCT FROM p_contact OR r.environment IS DISTINCT FROM p_env OR (r.command_kind='edit' AND r.payload_sha256 IS DISTINCT FROM v_hash) THEN
   RAISE EXCEPTION 'Directory request mismatch' USING ERRCODE='23514',CONSTRAINT='b015_request_identity';
  END IF;
  RETURN jsonb_build_object('status','recorded','request_id',r.request_id,'outcome',r.outcome,'recorded_at',r.created_at);
 END IF;
 -- Every serialized terminal rejection is metadata in the SAME authority, so a
 -- lost rejection response is recoverable without guessing that absence is final.
 -- Pin the actual same-org contact even for rejected metadata parent cleanup.
 SELECT * INTO c FROM public.contacts x WHERE x.org_id=p_org AND x.id=p_contact FOR UPDATE NOWAIT;
 IF FOUND THEN v_scoped:=c.id; END IF;
 IF NOT v_enabled THEN v_outcome:='rejected_disabled';
 ELSIF v_name='' OR length(v_name)>120 OR v_name ~ '[[:cntrl:]]'
  OR (v_email IS NOT NULL AND (length(v_email)>254 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'))
  OR (v_phone IS NOT NULL AND v_phone !~ '^\+[1-9][0-9]{6,14}$')
  OR coalesce(p_expected,'') !~ '^[0-9a-fA-F]{64}$' THEN v_outcome:='rejected_invalid';
 ELSIF v_scoped IS NULL OR NOT c.is_tenant OR c.archived_at IS NOT NULL THEN v_outcome:='rejected_unavailable';
 ELSE
  v_snapshot:=app.b015_contact_snapshot(p_org,p_contact);
  IF v_snapshot IS DISTINCT FROM lower(p_expected) THEN v_outcome:='rejected_conflict';
  ELSIF c.display_name IS NOT DISTINCT FROM v_name AND c.email::text IS NOT DISTINCT FROM v_email AND c.phone_e164 IS NOT DISTINCT FROM v_phone THEN
   v_outcome:='no_change';
  ELSE
   v_prior_reason:=current_setting('app.change_reason',true); v_prior_request:=current_setting('app.request_id',true);
   PERFORM set_config('app.change_reason','tenant_directory_contact_edit',true),set_config('app.request_id',p_request::text,true);
   BEGIN
    UPDATE public.contacts SET display_name=v_name,email=v_email,phone_e164=v_phone WHERE org_id=p_org AND id=p_contact;
    v_outcome:='changed';
   EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
    IF v_constraint='contacts_org_tenant_email_uniq' THEN v_outcome:='rejected_email_exists'; ELSE RAISE; END IF;
   END;
   PERFORM set_config('app.change_reason',coalesce(v_prior_reason,''),true),set_config('app.request_id',coalesce(v_prior_request,''),true);
   v_snapshot:=app.b015_contact_snapshot(p_org,p_contact);
  END IF;
 END IF;
 -- Clock expiry is independent of row locks. All failures roll back the real
 -- contact/audit/command transaction, including the deferred context guard.
 PERFORM * FROM app.b015_edit_context(p_org,p_live,p_env,p_session);
 INSERT INTO app.b015_edit_commands(org_id,actor_id,request_id,requested_contact_id,scoped_contact_id,environment,payload_sha256,result_sha256,actor_role,session_id,outcome)
 VALUES(p_org,v_actor,p_request,p_contact,v_scoped,p_env,v_hash,v_snapshot,v_role,p_session,v_outcome)
 RETURNING * INTO r;
 RETURN jsonb_build_object('status','recorded','request_id',r.request_id,'outcome',r.outcome,'recorded_at',r.created_at);
END $$;
REVOKE ALL ON FUNCTION app.b015_edit_contact(uuid,uuid,text,uuid,uuid,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b015_edit_contact(uuid,uuid,text,uuid,uuid,uuid,text,text,text,text) TO service_role;
-- Close only a serialized, confirmed-absent request key. This is not a
-- reversal of any edit and does not require the lost original PII payload.
CREATE FUNCTION app.b015_close_edit_request(p_org uuid,p_live uuid,p_env text,p_session uuid,p_contact uuid,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
DECLARE v_actor uuid:=auth.uid(); v_role text; v_scoped uuid; r app.b015_edit_commands;
BEGIN
 SELECT x.actor_role INTO v_role FROM app.b015_edit_context(p_org,p_live,p_env,p_session) x;
 IF p_contact IS NULL OR p_request IS NULL THEN RAISE EXCEPTION 'Invalid directory operation' USING ERRCODE='22023'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('b015-edit:'||p_org::text||':'||v_actor::text||':'||p_request::text,0)) THEN
  RAISE EXCEPTION 'Directory operation busy' USING ERRCODE='55P03';
 END IF;
 SELECT * INTO r FROM app.b015_edit_commands x WHERE x.org_id=p_org AND x.actor_id=v_actor AND x.request_id=p_request;
 IF FOUND THEN
  IF r.requested_contact_id IS DISTINCT FROM p_contact OR r.environment IS DISTINCT FROM p_env THEN
   RAISE EXCEPTION 'Directory request mismatch' USING ERRCODE='23514',CONSTRAINT='b015_request_identity';
  END IF;
  -- A committed edit or rejection always wins, with its original outcome.
  RETURN jsonb_build_object('status','recorded','request_id',r.request_id,'outcome',r.outcome,'recorded_at',r.created_at);
 END IF;
 SELECT c.id INTO v_scoped FROM public.contacts c WHERE c.org_id=p_org AND c.id=p_contact FOR KEY SHARE NOWAIT;
 PERFORM * FROM app.b015_edit_context(p_org,p_live,p_env,p_session);
 INSERT INTO app.b015_edit_commands(org_id,actor_id,request_id,requested_contact_id,scoped_contact_id,environment,command_kind,payload_sha256,actor_role,session_id,outcome)
 VALUES(p_org,v_actor,p_request,p_contact,v_scoped,p_env,'close',NULL,v_role,p_session,'cancelled') RETURNING * INTO r;
 RETURN jsonb_build_object('status','recorded','request_id',r.request_id,'outcome',r.outcome,'recorded_at',r.created_at);
END $$;
REVOKE ALL ON FUNCTION app.b015_close_edit_request(uuid,uuid,text,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b015_close_edit_request(uuid,uuid,text,uuid,uuid,uuid) TO service_role;

-- Fixed server operation calls this after ALL deferred checks, then directly
-- awaits COMMIT. Recovery remains current-auth even OFF or after contact changes.
CREATE FUNCTION app.b015_finish_edit_request(p_org uuid,p_live uuid,p_env text,p_session uuid,p_contact uuid,p_request uuid,p_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
DECLARE r app.b015_edit_commands; result jsonb;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN('edit','close','status') OR p_contact IS NULL OR p_request IS NULL THEN
  RAISE EXCEPTION 'Directory operation unavailable' USING ERRCODE='42501';
 END IF;
 PERFORM * FROM app.b015_edit_context(p_org,p_live,p_env,p_session);
 SELECT * INTO r FROM app.b015_edit_commands c
  WHERE c.org_id=p_org AND c.actor_id=auth.uid() AND c.request_id=p_request FOR SHARE NOWAIT;
 IF FOUND THEN
  IF r.requested_contact_id IS DISTINCT FROM p_contact OR r.environment IS DISTINCT FROM p_env THEN
   RAISE EXCEPTION 'Directory request mismatch' USING ERRCODE='23514',CONSTRAINT='b015_request_identity';
  END IF;
  result:=jsonb_build_object('status','recorded','request_id',r.request_id,'outcome',r.outcome,'recorded_at',r.created_at);
 ELSE
  IF p_mode<>'status' THEN RAISE EXCEPTION 'Directory request unavailable' USING ERRCODE='23514'; END IF;
  result:=jsonb_build_object('status','unknown');
 END IF;
 -- No business queries or writes follow this current-authority check.
 PERFORM * FROM app.b015_edit_context(p_org,p_live,p_env,p_session);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b015_finish_edit_request(uuid,uuid,text,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b015_finish_edit_request(uuid,uuid,text,uuid,uuid,uuid,text) TO service_role;

CREATE FUNCTION app.b015_edit_view(p_org uuid,p_live uuid,p_env text,p_session uuid,p_contact uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='500ms' AS $$
DECLARE c public.contacts; v_enabled boolean; result jsonb;
BEGIN
 SELECT enabled INTO v_enabled FROM app.b015_edit_context(p_org,p_live,p_env,p_session);
 IF NOT v_enabled THEN RETURN jsonb_build_object('state','disabled'); END IF;
 SELECT * INTO c FROM public.contacts x WHERE x.org_id=p_org AND x.id=p_contact AND x.is_tenant AND x.archived_at IS NULL FOR SHARE NOWAIT;
 IF NOT FOUND THEN
  PERFORM * FROM app.b015_edit_context(p_org,p_live,p_env,p_session);
  RETURN jsonb_build_object('state','recovery_only');
 END IF;
 result:=jsonb_build_object('state','enabled','contactId',c.id,'name',c.display_name,'email',c.email::text,'phone',c.phone_e164,
  'expected',app.b015_contact_snapshot(p_org,c.id),'isOwner',c.is_owner,'isVendor',c.is_vendor);
 SELECT enabled INTO v_enabled FROM app.b015_edit_context(p_org,p_live,p_env,p_session);
 IF NOT v_enabled THEN RETURN jsonb_build_object('state','disabled'); END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b015_edit_view(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b015_edit_view(uuid,uuid,text,uuid,uuid) TO service_role;
COMMIT;
