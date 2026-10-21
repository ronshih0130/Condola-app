-- Version 20261024180000.
-- Portal logins treat email as case-insensitive.
--
-- auth.users.email is case-sensitive text. A contact stored as User@x.com and
-- a login stored as user@x.com would otherwise become two accounts. This
-- function still inserts a new user. It never returns an existing id.
-- A taken address, in any case, raises unique_violation so the caller can
-- mint portal-<uuid>@demo.condola.local instead of linking that login.
-- The advisory lock closes the gap between the case-insensitive check and the
-- case-sensitive unique index.

CREATE OR REPLACE FUNCTION app.provision_portal_user(p_email text, p_name text, p_phone text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public, pg_temp
AS $$
DECLARE
  new_id uuid := gen_random_uuid();
  login_email text := lower(btrim(coalesce(p_email, '')));
BEGIN
  IF login_email = '' THEN
    RAISE EXCEPTION 'email required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(login_email));
  IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = login_email) THEN
    RAISE EXCEPTION 'duplicate key value violates unique constraint "users_email_key"'
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    recovery_token,
    email_change_token_new,
    email_change,
    email_change_token_current,
    email_change_confirm_status,
    phone_change,
    phone_change_token,
    reauthentication_token,
    is_sso_user,
    is_anonymous
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    new_id,
    'authenticated',
    'authenticated',
    login_email,
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', p_name),
    now(),
    now(),
    '',
    '',
    '',
    '',
    '',
    0,
    '',
    '',
    '',
    false,
    false
  );

  INSERT INTO public.profiles (id, display_name, email, phone_e164, locale)
  VALUES (new_id, p_name, login_email, NULLIF(btrim(coalesce(p_phone, '')), ''), 'zh-TW');

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION app.provision_portal_user(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.provision_portal_user(text, text, text) TO service_role;
