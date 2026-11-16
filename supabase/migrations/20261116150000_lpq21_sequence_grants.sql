-- Version 20261116150000.
-- LPQ-21 / B-108, Ron 2026-11-16 (「LPQ-21 併入 PR」): follow-up to PR-029. Supabase's default privileges still
-- give anon USAGE/SELECT/UPDATE on every NEW sequence the postgres role creates in public, and the five existing
-- public sequences carry that grant (receipt receipts/brand3/b3/b108-staging-apply.md). With USAGE anon could call
-- nextval and burn ids; it never had table access, so no data was exposed. This removes anon/PUBLIC from the
-- existing public sequences and from the postgres default for new ones. authenticated and service_role are
-- unchanged; so are tables (PR-026/PR-029), functions and the supabase_admin defaults (the Mac cannot alter them).
-- The app never uses the anon role (tx() = authenticated, svc() = service_role, query()/withClient() = owner).
-- CI and local clusters have no postgres role, so the default-privilege half is a no-op there (as PR-029); the
-- existing-sequence revoke runs everywhere and is a no-op where anon holds nothing. Prod: box PE.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, PUBLIC;

DO $lpq21$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'postgres') THEN
    RAISE NOTICE 'LPQ-21: no postgres role on this database; default privileges unchanged';
    RETURN;
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'postgres', 'MEMBER') THEN
    RAISE EXCEPTION 'LPQ-21: % cannot alter default privileges for postgres', current_user;
  END IF;
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, PUBLIC';
END
$lpq21$;
