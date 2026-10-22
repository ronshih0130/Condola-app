-- Dedicated Hyperdrive login for server-side reads.
-- Version 20261029130000. 20261026130000 is bulk_import on another branch.
-- Additive and idempotent: CREATE/ALTER ROLE and GRANTs only.
-- No table changes, no new constraints, and no dropped objects.
-- CI applies this file. It does not set a login secret and it does not grant
-- service_role. The operator sets the secret out of band (see README) and
-- passes it only to `wrangler hyperdrive create`.
--
-- The role is NOINHERIT because tx() runs SET LOCAL ROLE authenticated.
-- It has no table grants of its own, so RLS applies as authenticated and a
-- missed SET ROLE fails closed. This file never assigns a login secret.
-- Session lookup and service_role writes stay on the existing DATABASE_URL login.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'condola_hyperdrive') THEN
    CREATE ROLE condola_hyperdrive
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      LOGIN
      NOINHERIT;
  ELSE
    ALTER ROLE condola_hyperdrive
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      LOGIN
      NOINHERIT;
  END IF;
END $$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO condola_hyperdrive', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO condola_hyperdrive;
GRANT authenticated TO condola_hyperdrive;
