-- Hosted auth.users.id has no default, so the previous provision function
-- failed with a not-null violation. Replace it. Do not edit the applied
-- migration. The row also fills the token columns GoTrue scans as text.

CREATE OR REPLACE FUNCTION app.provision_portal_user(p_email text, p_name text, p_phone text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public, pg_temp
AS $$
DECLARE
  new_id uuid := gen_random_uuid();
BEGIN
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
    p_email,
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
  VALUES (new_id, p_name, p_email, NULLIF(btrim(coalesce(p_phone, '')), ''), 'zh-TW');

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION app.provision_portal_user(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.provision_portal_user(text, text, text) TO service_role;
