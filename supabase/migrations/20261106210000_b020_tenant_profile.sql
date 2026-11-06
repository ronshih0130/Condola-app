-- B-020 slice 2. Account profile overrides are separate from staff-maintained contacts.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- One bounded counter per user/action; no raw input or credential is retained.
CREATE TABLE app.b020_profile_mutations (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('profile','password')),
  window_start timestamptz NOT NULL,
  attempts int NOT NULL,
  PRIMARY KEY(user_id,kind)
);
ALTER TABLE app.b020_profile_mutations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b020_profile_mutations FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b020_consume_mutation(p_kind text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE v_count int; v_limit int:=CASE WHEN p_kind='profile' THEN 20 ELSE 10 END;
BEGIN
  -- Caller holds the user lock and has already passed profile admission.
  INSERT INTO app.b020_profile_mutations AS m(user_id,kind,window_start,attempts)
    VALUES(auth.uid(),p_kind,clock_timestamp(),1)
    ON CONFLICT(user_id,kind) DO UPDATE SET
      window_start=CASE WHEN m.window_start<=clock_timestamp()-interval '15 minutes' THEN clock_timestamp() ELSE m.window_start END,
      attempts=CASE WHEN m.window_start<=clock_timestamp()-interval '15 minutes' THEN 1 ELSE m.attempts+1 END
    WHERE m.window_start<=clock_timestamp()-interval '15 minutes' OR m.attempts<v_limit
    RETURNING attempts INTO v_count;
  RETURN v_count IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION app.b020_consume_mutation(text) FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE app.b020_tenant_profiles (
  org_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{1,14}$'),
  version text NOT NULL DEFAULT gen_random_uuid()::text,
  PRIMARY KEY (org_id, contact_id, user_id),
  FOREIGN KEY (org_id, contact_id) REFERENCES public.contacts(org_id, id)
);
ALTER TABLE app.b020_tenant_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b020_tenant_profiles FROM PUBLIC, anon, authenticated, service_role;

-- Server-only authority gate. Locks fence flag disable, archive, session revoke and pin changes.
CREATE FUNCTION app.b020_profile_admit(p_org uuid, p_current uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE v_global jsonb; v_flags jsonb; v_env text; v_contact uuid;
BEGIN
  SELECT value INTO v_global FROM public.platform_settings WHERE key='tenant_account_settings' FOR SHARE;
  SELECT feature_flags, environment::text INTO v_flags,v_env FROM public.organizations WHERE id=p_org FOR SHARE;
  IF (v_global->'enabled'='true'::jsonb AND jsonb_typeof(v_global->'allowed_org_ids')='array'
      AND v_global->'allowed_org_ids' @> jsonb_build_array(p_org::text)
      AND v_flags->'tenant_account_settings'='true'::jsonb) IS NOT TRUE
     OR auth.uid() IS NULL OR nullif(current_setting('app.active_org_id',true),'') IS DISTINCT FROM p_org::text
     OR nullif(current_setting('app.env',true),'') IS DISTINCT FROM v_env THEN
    RAISE EXCEPTION 'Account settings unavailable' USING ERRCODE='42501';
  END IF;
  SELECT id INTO v_contact FROM public.contacts WHERE org_id=p_org AND user_id=auth.uid()
    AND is_tenant AND archived_at IS NULL ORDER BY created_at,id LIMIT 1 FOR UPDATE;
  IF v_contact IS NULL THEN RAISE EXCEPTION 'Account settings unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.auth_sessions WHERE id=p_current AND user_id=auth.uid()
    AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='42501'; END IF;
  RETURN v_contact;
END $$;
REVOKE ALL ON FUNCTION app.b020_profile_admit(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b020_profile(p_org uuid,p_current uuid)
RETURNS TABLE(display_name text,phone_e164 text,version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE v_contact uuid;
BEGIN
  v_contact:=app.b020_profile_admit(p_org,p_current);
  RETURN QUERY SELECT coalesce(p.display_name,c.display_name),coalesce(p.phone_e164,c.phone_e164,''),
    coalesce(p.version,md5(jsonb_build_array(c.id,c.display_name,c.phone_e164,c.updated_at)::text))
    FROM public.contacts c LEFT JOIN app.b020_tenant_profiles p ON p.contact_id=c.id AND p.org_id=c.org_id AND p.user_id=auth.uid()
    WHERE c.id=v_contact;
END $$;
REVOKE ALL ON FUNCTION app.b020_profile(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b020_profile(uuid,uuid) TO service_role;

CREATE FUNCTION app.b020_save_profile(p_org uuid,p_current uuid,p_name text,p_phone text,p_version text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE v_contact uuid; v_version text;
BEGIN
  -- Same user-before-contact order as password changes, including the profile FK check.
  PERFORM 1 FROM auth.users WHERE id=auth.uid() FOR UPDATE;
  v_contact:=app.b020_profile_admit(p_org,p_current);
  IF NOT app.b020_consume_mutation('profile') THEN RETURN 'unavailable'; END IF;
  SELECT version INTO v_version FROM app.b020_profile(p_org,p_current);
  IF p_version IS DISTINCT FROM v_version THEN RETURN 'stale'; END IF;
  IF p_name IS NULL OR btrim(p_name)='' OR length(p_name)>100 OR octet_length(p_name)>400
    OR p_name ~ '[[:cntrl:]]' OR (p_phone ~ '^\+[1-9][0-9]{1,14}$') IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid profile' USING ERRCODE='22023';
  END IF;
  INSERT INTO app.b020_tenant_profiles(org_id,contact_id,user_id,display_name,phone_e164)
    VALUES(p_org,v_contact,auth.uid(),p_name,p_phone)
    ON CONFLICT(org_id,contact_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name,
      phone_e164=EXCLUDED.phone_e164,version=gen_random_uuid()::text;
  RETURN 'updated';
END $$;
REVOKE ALL ON FUNCTION app.b020_save_profile(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b020_save_profile(uuid,uuid,text,text,text) TO service_role;

-- Service-only: policies supplied by the trusted server from password.ts / lockout.ts.
-- Re-entering the current password is the recent-auth proof; session age alone never suffices.
CREATE FUNCTION app.b020_change_password(p_org uuid,p_current uuid,p_old text,p_new text,p_limit int,p_lock_ms int)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE v_user auth.users%ROWTYPE; v_attempt public.auth_login_attempts%ROWTYPE; v_count int; v_session uuid; v_cost int; v_actual bytea; v_expected bytea; v_diff int:=0; v_i int;
BEGIN
  -- Serialize different devices of this user before any session locks/revocations.
  SELECT * INTO v_user FROM auth.users WHERE id=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account unavailable' USING ERRCODE='42501'; END IF;
  PERFORM app.b020_profile_admit(p_org,p_current);
  IF p_old IS NULL OR p_old='' THEN RETURN 'reauth'; END IF;
  SELECT * INTO v_attempt FROM public.auth_login_attempts WHERE email=lower(v_user.email) FOR UPDATE;
  IF v_attempt.locked_until>clock_timestamp() THEN RETURN 'locked'; END IF;
  IF NOT app.b020_consume_mutation('password') THEN RETURN 'unavailable'; END IF;
  -- Fixed-length digest comparison: inspect all 32 bytes, without a
  -- prefix-dependent text/bytea equality or an early exit. pgcrypto lives in
  -- public; built-in byte access is explicitly pg_catalog-qualified.
  v_actual:=public.digest(public.crypt(p_old,v_user.encrypted_password),'sha256');
  v_expected:=public.digest(v_user.encrypted_password,'sha256');
  FOR v_i IN 0..31 LOOP
    v_diff:=v_diff | (pg_catalog.get_byte(v_actual,v_i) # pg_catalog.get_byte(v_expected,v_i));
  END LOOP;
  IF v_user.email_confirmed_at IS NULL OR v_user.encrypted_password IS NULL OR v_user.encrypted_password=''
     OR (v_diff=0) IS NOT TRUE THEN
    v_count:=CASE WHEN v_attempt.locked_until IS NOT NULL THEN 1 ELSE coalesce(v_attempt.failed_count,0)+1 END;
    INSERT INTO public.auth_login_attempts(email,failed_count,locked_until,updated_at)
      VALUES(lower(v_user.email),v_count,CASE WHEN v_count>=p_limit THEN clock_timestamp()+p_lock_ms*interval '1 millisecond' END,clock_timestamp())
      ON CONFLICT(email) DO UPDATE SET failed_count=EXCLUDED.failed_count,locked_until=EXCLUDED.locked_until,updated_at=EXCLUDED.updated_at;
    RETURN CASE WHEN v_count>=p_limit THEN 'locked' ELSE 'invalid' END;
  END IF;
  -- Preserve stronger bcrypt work factors; upgrade legacy cost 6 to at least 10.
  v_cost:=greatest(coalesce(substring(v_user.encrypted_password FROM '^\$2[aby]\$([0-9]{2})\$')::int,10),10);
  UPDATE auth.users SET encrypted_password=public.crypt(p_new,public.gen_salt('bf',v_cost)),updated_at=clock_timestamp() WHERE id=auth.uid();
  DELETE FROM public.auth_challenges WHERE user_id=auth.uid();
  FOR v_session IN SELECT id FROM public.auth_sessions WHERE user_id=auth.uid() AND id<>p_current AND revoked_at IS NULL ORDER BY id LOOP
    PERFORM app.b020_revoke_session(p_org,v_session,p_current);
  END LOOP;
  DELETE FROM public.auth_login_attempts WHERE email=lower(v_user.email);
  RETURN 'changed';
END $$;
REVOKE ALL ON FUNCTION app.b020_change_password(uuid,uuid,text,text,int,int) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b020_change_password(uuid,uuid,text,text,int,int) TO service_role;
COMMIT;
