-- Version 20261030151100.
-- Preserve indexed comparisons by casting the parameter, never user_id.

CREATE OR REPLACE FUNCTION app.end_auth_sessions(p_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public, pg_temp
AS $$
DECLARE
  refresh_user_type oid;
  original_state text;
BEGIN
  IF to_regclass('auth.sessions') IS NOT NULL THEN
    EXECUTE 'DELETE FROM auth.sessions WHERE user_id = $1' USING p_user;
  END IF;

  IF to_regclass('auth.refresh_tokens') IS NOT NULL THEN
    SELECT a.atttypid
      INTO refresh_user_type
      FROM pg_catalog.pg_attribute AS a
      WHERE a.attrelid = to_regclass('auth.refresh_tokens')
        AND a.attname = 'user_id'
        AND a.attnum > 0
        AND NOT a.attisdropped;

    IF refresh_user_type = 'pg_catalog.uuid'::pg_catalog.regtype THEN
      EXECUTE 'DELETE FROM auth.refresh_tokens WHERE user_id = $1' USING p_user;
    ELSIF refresh_user_type IN (
      'pg_catalog.text'::pg_catalog.regtype,
      'pg_catalog.varchar'::pg_catalog.regtype
    ) THEN
      EXECUTE 'DELETE FROM auth.refresh_tokens WHERE user_id = $1::text' USING p_user;
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = 'CA402',
        MESSAGE = 'END_AUTH_SESSIONS_UNSUPPORTED_USER_ID_TYPE';
    END IF;
  END IF;

EXCEPTION WHEN OTHERS THEN
  -- This exception block rolls back both deletes before reporting failure.
  -- A stable code exposes failure without leaking row data or user identifiers.
  GET STACKED DIAGNOSTICS original_state = RETURNED_SQLSTATE;
  RAISE EXCEPTION USING
    ERRCODE = 'CA401',
    MESSAGE = 'END_AUTH_SESSIONS_FAILED',
    DETAIL = 'original_sqlstate=' || original_state;
END $$;

REVOKE ALL ON FUNCTION app.end_auth_sessions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.end_auth_sessions(uuid) TO service_role;
