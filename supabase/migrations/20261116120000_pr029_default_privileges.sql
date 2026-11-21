-- Version 20261116120000.
-- PR-029 (a), Ron 2026-11-16 ~02:20 PT (「按照建議」, relayed by the Brand 3.0 Design Session): stop future
-- default-grant drift. PR-026 revoked anon/PUBLIC on today's nine tables, but Supabase's default privileges still
-- give anon every NEW table that the postgres role creates in public (receipt
-- receipts/brand3/b3/pr029-staging-apply.md: pg_default_acl postgres/public/r = anon=arwdxtm). This removes that
-- default for anon and PUBLIC. authenticated and service_role defaults are out of scope (Ron: anon/public only),
-- and so are sequences, functions and the supabase_admin defaults (the Mac cannot alter them; no public table is
-- owned by supabase_admin). Existing table grants are unchanged.
-- CI and local clusters have no postgres role (their superuser is condola), so there the block is a no-op. A
-- database that has the role but where the current user cannot act for it fails closed. Prod is not touched by
-- the Mac: box PE checks prod read-only and ships it through the normal prod path.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pr029$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'postgres') THEN
    RAISE NOTICE 'PR-029: no postgres role on this database; nothing to change';
    RETURN;
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'postgres', 'MEMBER') THEN
    RAISE EXCEPTION 'PR-029: % cannot alter default privileges for postgres', current_user;
  END IF;
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, PUBLIC';
END
$pr029$;
