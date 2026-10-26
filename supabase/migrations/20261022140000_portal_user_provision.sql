-- Version 20261022140000.
-- Portal owners and tenants are created by the app as service_role.
-- Hosted Supabase does not grant that role write access to auth.users, and
-- opening the table would let the role read and write every account.
-- This function runs as its owner (the migration role) and only inserts the
-- portal user plus a profile.

CREATE OR REPLACE FUNCTION app.provision_portal_user(p_email text, p_name text, p_phone text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public, pg_temp
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO auth.users (email, raw_user_meta_data, email_confirmed_at, role, aud)
  VALUES (
    p_email,
    jsonb_build_object('name', p_name),
    now(),
    'authenticated',
    'authenticated'
  )
  RETURNING id INTO new_id;

  INSERT INTO public.profiles (id, display_name, email, phone_e164, locale)
  VALUES (new_id, p_name, p_email, NULLIF(btrim(coalesce(p_phone, '')), ''), 'zh-TW');

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION app.provision_portal_user(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.provision_portal_user(text, text, text) TO service_role;

-- Match hosted Supabase: service_role may not write auth.users.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON auth.users FROM service_role;
