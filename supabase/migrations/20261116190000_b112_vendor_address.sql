-- B-112 VEN-ADDR (Round 7 batch 4 ven-addr-confirm; VEN-18-AC5, AC6, VEN-17-AC6): a signed-in vendor confirms the
-- parsed parts of their own one-line address and saves it. The confirmed parts are joined back into the existing
-- vendor_profiles.address line (no structured columns). Every save appends a vendor_profile_versions row, so issued
-- documents keep the address they were issued with (VEN-18-AC6), carries the current seal reference forward, writes
-- an audit row and is idempotent per request id. Admission is the B-026 account session only (app.b026_account_actor),
-- never a job or document token; gate = vendor_workbench + the B-026 vendor account gate + effective brand_v3.
-- No issuer type, name, phone or tax id change (B-065). No outbound.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- One row per accepted save; a replay of the same request returns it.
CREATE TABLE app.b112_address_saves (
 org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 user_id uuid NOT NULL,
 vendor_profile_id uuid NOT NULL,
 version integer NOT NULL CHECK (version >= 1),
 version_id uuid NOT NULL REFERENCES public.vendor_profile_versions(id) ON DELETE CASCADE,
 address text NOT NULL CHECK (length(btrim(address)) BETWEEN 1 AND 500),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (org_id, request_id),
 FOREIGN KEY (org_id, vendor_profile_id) REFERENCES public.vendor_profiles(org_id, id) ON DELETE CASCADE
);
ALTER TABLE app.b112_address_saves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b112_address_saves FROM PUBLIC,anon,authenticated,service_role;

-- Gate: the org's vendor_workbench flag, the B-026 account gate and effective brand_v3 (env BRAND_V2 or org brand_v2).
CREATE FUNCTION app.b112_enabled(p_org uuid,p_env_v2 boolean) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce((SELECT o.feature_flags->'vendor_workbench'='true'::jsonb
  AND o.feature_flags->'brand_v3'='true'::jsonb
  AND (coalesce(p_env_v2,false) OR o.feature_flags->'brand_v2'='true'::jsonb)
  AND coalesce(app.b026_accounts_enabled(o.id),false)
  FROM public.organizations o WHERE o.id=p_org),false)
$$;
REVOKE ALL ON FUNCTION app.b112_enabled(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Admission: live account session -> its vendor account in this org -> that contact's profile (or none).
-- Raises 42501 for anything not admitted. p_lock takes the profile row lock for the writer.
CREATE FUNCTION app.b112_account_profile(p_session_hash text,p_org uuid,p_env_v2 boolean,p_lock boolean,
 OUT actor uuid,OUT profile public.vendor_profiles)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE contact uuid;
BEGIN
 IF p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$' OR p_org IS NULL
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 actor:=app.b026_account_actor(p_session_hash);
 IF NOT app.b112_enabled(p_org,p_env_v2) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT a.contact_id INTO contact FROM app.b026_vendor_accounts a
  JOIN public.contacts c ON c.org_id=a.org_id AND c.id=a.contact_id AND c.is_vendor AND c.archived_at IS NULL
  WHERE a.org_id=p_org AND a.user_id=actor;
 IF contact IS NULL THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_lock THEN
  -- Lock the profile together with its whole binding: the caller's account row in this org for this contact and
  -- the live vendor contact. Under READ COMMITTED a row changed while waiting is re-checked against these joins,
  -- and FOR SHARE keeps the account and contact from changing until this transaction ends.
  SELECT p.* INTO profile FROM public.vendor_profiles p
   JOIN app.b026_vendor_accounts va ON va.org_id=p.org_id AND va.contact_id=p.contact_id AND va.user_id=actor
   JOIN public.contacts c ON c.org_id=p.org_id AND c.id=p.contact_id AND c.is_vendor AND c.archived_at IS NULL
   WHERE p.org_id=p_org AND p.contact_id=contact
   FOR UPDATE OF p FOR SHARE OF va, c;
  -- Re-admit everything after the lock wait, in this statement's snapshot: session, gate and the full binding.
  IF profile.id IS NULL OR NOT app.b112_enabled(p_org,p_env_v2) OR app.b026_account_actor(p_session_hash) IS DISTINCT FROM actor
   OR NOT EXISTS(SELECT 1 FROM app.b026_vendor_accounts va
     JOIN public.contacts c ON c.org_id=va.org_id AND c.id=va.contact_id AND c.is_vendor AND c.archived_at IS NULL
     JOIN public.vendor_profiles p ON p.org_id=va.org_id AND p.contact_id=va.contact_id AND p.id=profile.id
     WHERE va.org_id=p_org AND va.user_id=actor AND va.contact_id=contact)
  THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 ELSE
  SELECT * INTO profile FROM public.vendor_profiles p WHERE p.org_id=p_org AND p.contact_id=contact;
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.b112_account_profile(text,uuid,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Read: the signed-in vendor's own profile address in this org; NULL when they have no profile yet.
CREATE FUNCTION app.b112_vendor_address(p_session_hash text,p_org uuid,p_env_v2 boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM app.b112_account_profile(p_session_hash,p_org,p_env_v2,false);
 IF (a.profile).id IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('profileId',(a.profile).id,'version',(a.profile).current_version,
  'kind',(a.profile).kind,'address',(a.profile).address);
END $$;
REVOKE ALL ON FUNCTION app.b112_vendor_address(text,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b112_vendor_address(text,uuid,boolean) TO service_role;

-- Write: save the confirmed address line as a new profile version. Idempotent per (org, request id).
CREATE FUNCTION app.b112_save_vendor_address(p_session_hash text,p_org uuid,p_env_v2 boolean,p_request uuid,
 p_expected_version integer,p_address text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a record; prior app.b112_address_saves; latest jsonb; next_version public.vendor_profile_versions; line text;
BEGIN
 SELECT * INTO a FROM app.b112_account_profile(p_session_hash,p_org,p_env_v2,true);
 IF (a.profile).id IS NULL THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_request IS NULL THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
 -- Serialize on the idempotency key: two vendors (different profile locks) sharing a request id cannot both miss
 -- the ledger; the second sees the first's committed row and gets rejected_conflict.
 PERFORM pg_advisory_xact_lock(hashtextextended('b112/address/'||p_org::text||'/'||p_request::text,0));
 SELECT * INTO prior FROM app.b112_address_saves s WHERE s.org_id=p_org AND s.request_id=p_request;
 IF FOUND THEN
  IF prior.user_id=a.actor AND prior.vendor_profile_id=(a.profile).id THEN
   RETURN jsonb_build_object('status','recorded','version',prior.version,'address',prior.address,'replayed',true); END IF;
  RETURN '{"status":"rejected_conflict"}'::jsonb;
 END IF;
 line:=btrim(p_address);
 IF p_address IS NULL OR length(line) NOT BETWEEN 1 AND 500 OR line ~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]'
 THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
 IF p_expected_version IS DISTINCT FROM (a.profile).current_version THEN RETURN '{"status":"rejected_stale"}'::jsonb; END IF;
 IF line IS NOT DISTINCT FROM (a.profile).address THEN
  RETURN jsonb_build_object('status','unchanged','version',(a.profile).current_version,'address',line);
 END IF;
 -- The new version carries the current seal reference forward (or, for an object-backed seal, seal_file_id).
 SELECT v.snapshot INTO latest FROM public.vendor_profile_versions v
  WHERE v.org_id=p_org AND v.vendor_profile_id=(a.profile).id AND v.version=(a.profile).current_version;
 UPDATE public.vendor_profiles SET address=line,current_version=current_version+1,updated_at=clock_timestamp()
  WHERE id=(a.profile).id AND org_id=p_org AND current_version=p_expected_version;
 IF NOT FOUND THEN RETURN '{"status":"rejected_stale"}'::jsonb; END IF;
 INSERT INTO public.vendor_profile_versions(org_id,vendor_profile_id,version,kind,display_name,business_name,
  representative_name,tax_id,phone_e164,address,service_job_types,qualification_attested_at,seal_file_id,snapshot)
 SELECT p.org_id,p.id,p.current_version,p.kind,p.display_name,p.business_name,p.representative_name,p.tax_id,
  p.phone_e164,p.address,p.service_job_types,p.qualification_attested_at,p.seal_file_id,
  jsonb_build_object('confirmation_method','vendor_account')
   || CASE WHEN latest ? 'seal' THEN jsonb_build_object('seal',latest->'seal') ELSE '{}'::jsonb END
 FROM public.vendor_profiles p WHERE p.id=(a.profile).id AND p.org_id=p_org
 RETURNING * INTO next_version;
 BEGIN
  INSERT INTO app.b112_address_saves(org_id,request_id,user_id,vendor_profile_id,version,version_id,address)
  VALUES (p_org,p_request,a.actor,(a.profile).id,next_version.version,next_version.id,line);
 EXCEPTION WHEN unique_violation THEN
  -- Defence in depth behind the advisory lock: never surface 23505. The block's subtransaction is rolled back,
  -- so raise to undo the profile update and version row too, mapped by the caller to rejected_conflict.
  RAISE EXCEPTION 'b112 request conflict' USING ERRCODE='P0B12';
 END;
 INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,old_row,new_row,changed_cols,request_id)
 VALUES (p_org,a.actor,'vendor','vendor_profiles',(a.profile).id::text,'update','vendor_account_address',
  jsonb_build_object('version',(a.profile).current_version),
  jsonb_build_object('version',next_version.version,'versionId',next_version.id),ARRAY['address'],p_request::text);
 RETURN jsonb_build_object('status','recorded','version',next_version.version,'address',line,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION app.b112_save_vendor_address(text,uuid,boolean,uuid,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b112_save_vendor_address(text,uuid,boolean,uuid,integer,text) TO service_role;
COMMIT;
