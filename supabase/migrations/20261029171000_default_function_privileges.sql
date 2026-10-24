-- Stop new functions in schema public from being executable by anon,
-- authenticated, or PUBLIC.
--
-- Supabase grants EXECUTE on every new function to anon, authenticated, and
-- service_role. Postgres also grants EXECUTE to PUBLIC. A migration that only
-- CREATE FUNCTIONs therefore exposes the function through the Data API.
--
-- This file changes the default for functions created later. It does not
-- REVOKE EXECUTE on any function that already exists. An audit of those
-- grants is a separate migration.
--
-- Roles: hosted migrations create functions as postgres, and Supabase's own
-- defaults are recorded for supabase_admin. Skip a role that is not installed
-- (local Postgres has no supabase_admin). anon and authenticated are required;
-- both exist on hosted Supabase and in supabase/stub/supabase_stub.sql.
--
-- Hosted Supabase rejects ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin
-- with 42501 (permission denied to change default privileges). The postgres
-- role statements above are unchanged. The supabase_admin statements sit in
-- their own DO block, which catches insufficient_privilege and raises a
-- notice so this migration still commits. A later run is the same: a REVOKE
-- that already applied is a no-op, and a denied change notices again.
--
-- Safe to re-run. ALTER DEFAULT PRIVILEGES ... REVOKE is a no-op when the
-- grant is already gone. No table is rewritten.
--
-- After this migration, a function that clients call through RPC needs an
-- explicit grant and a line in supabase/rpc-allowlist.txt:
--
--   GRANT EXECUTE ON FUNCTION public.example(uuid) TO authenticated;

DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'anon and authenticated must exist before default EXECUTE is revoked';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  ELSE
    RAISE NOTICE 'role postgres is absent; skip default privileges for postgres';
  END IF;
END
$body$;

DO $supabase_admin$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    RAISE NOTICE 'role supabase_admin is absent; skip default privileges for supabase_admin';
    RETURN;
  END IF;

  BEGIN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'insufficient_privilege changing default privileges for role supabase_admin; skipping';
  END;
END
$supabase_admin$;
