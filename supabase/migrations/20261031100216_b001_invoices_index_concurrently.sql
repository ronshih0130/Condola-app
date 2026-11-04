-- condola:no-transaction
-- Apply through scripts/db-migrate.sh or psql -X -v ON_ERROR_STOP=1 -f.
-- Supabase CLI db push / migration up wraps each migration in a transaction
-- by default, which makes CONCURRENTLY fail. This marker is runner-specific:
-- use db-migrate.sh/psql, or split out this operation before using the CLI.
-- The conditional cleanup below also requires psql's \gexec.
--
-- Timestamp 20261031100216 is unused by every other migration. It sorts after
-- 20261031100215_b028_center_foundation.sql and before
-- 20261031100217_b010_b028_source_foundation.sql. 20261031100212 already
-- belongs to b010_b028_local_events; do not reuse that version. db-migrate.sh
-- tracks full filenames. A Supabase CLI ledger keyed only by timestamp still
-- needs each version to be unique, which this timestamp is.
--
-- Ordering: 20261031100213_b001_zero_first_invoice.sql replaces the completion
-- trigger function and has no dependency on this index (no index reference or
-- ON CONFLICT target). 20261031100214 and 20261031100215 do not insert invoices.
--
-- Enforcement gap: 20261031100211 only preflights duplicates that already
-- exist. Until this file builds the unique index, nothing in the database
-- rejects a second non-void source='move_in' invoice for the same lease.
-- db-migrate.sh and CI apply the two files in one back-to-back run. A deploy
-- pipeline that applies them with a gap must treat that window as unprotected.
--
-- Tooling reviewed: write-pr-migrations copies SQL unchanged; db-setup.sh,
-- CI's RLS bootstrap and full-history disposable DB tests use psql -f without
-- an outer transaction. test-disposable-db.ts only validates database URLs.
-- Transaction-wrapped targeted tests apply other, explicitly named migrations.
--
-- Retry after failure is intentional: retain a valid staging index, remove
-- only an invalid leftover build, and let concurrent creation check writes
-- that race with the preflight. Serialize migration runners.
-- 20261031100211 may already have been applied on staging with the index
-- created inline. Filename bookkeeping skips that edited file; IF NOT EXISTS
-- keeps a valid index, and the cleanup below drops only an invalid leftover.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.invoices WHERE source='move_in' AND status <> 'void'
             GROUP BY org_id,lease_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate move-in invoices require review' USING ERRCODE='23514';
  END IF;
END $$;

-- Execute at top level: DROP INDEX CONCURRENTLY cannot run inside a DO block.
SELECT 'DROP INDEX CONCURRENTLY IF EXISTS public.b001_one_live_move_in_invoice'
FROM pg_catalog.pg_index i
WHERE i.indexrelid = pg_catalog.to_regclass('public.b001_one_live_move_in_invoice')
  AND i.indisvalid = false
\gexec

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS b001_one_live_move_in_invoice
  ON public.invoices(org_id,lease_id)
  WHERE source='move_in' AND status <> 'void';
