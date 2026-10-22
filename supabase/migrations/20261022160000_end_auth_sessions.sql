-- Version 20261022160000.
-- Logout must also drop hosted GoTrue sessions. Local Postgres has no
-- auth.sessions table, so the deletes no-op when the relation is absent.

CREATE OR REPLACE FUNCTION app.end_auth_sessions(p_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public, pg_temp
AS $$
BEGIN
  IF to_regclass('auth.sessions') IS NOT NULL THEN
    EXECUTE 'DELETE FROM auth.sessions WHERE user_id = $1' USING p_user;
  END IF;
  IF to_regclass('auth.refresh_tokens') IS NOT NULL THEN
    BEGIN
      EXECUTE 'DELETE FROM auth.refresh_tokens WHERE user_id = $1' USING p_user;
    EXCEPTION WHEN undefined_column OR datatype_mismatch THEN
      EXECUTE 'DELETE FROM auth.refresh_tokens WHERE user_id = $1::text' USING p_user;
    END;
  END IF;
END $$;

REVOKE ALL ON FUNCTION app.end_auth_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.end_auth_sessions(uuid) TO service_role;
