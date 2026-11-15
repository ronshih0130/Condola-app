-- FILE: supabase/migrations/20261115120000_pr012_drop_staging_only_objects.sql
-- PENDING-RON PR-012, option (a) for two objects — Ron 2026-11-15 11:42 PT ("approve all CEO recommendations").
-- Staging carried two security-relevant objects that were never in `main` (found during the PR-010 catch-up,
-- condola-hub 20-build/receipts/staging-catchup/staging-drift-vs-main-history.txt):
--   1. files.receipt_file_read — an extra PERMISSIVE SELECT policy for `authenticated`. B-017's restrictive floor
--      still applied, but with custom roles OFF it could admit rows that B-027's narrowed photo policies do not.
--   2. app.read_request_session(text, text, text, text) — a SECURITY DEFINER session reader granted to a
--      `condola_hyperdrive` login role. No code in `main` calls it; nothing depends on it.
-- Fix-forward: drop both IF they exist. On any database built from `main` this file is a no-op. The other
-- staging-only objects listed in PR-012 are left for their own items. The `condola_hyperdrive` role itself is
-- not touched here.
DROP POLICY IF EXISTS receipt_file_read ON public.files;
DROP FUNCTION IF EXISTS app.read_request_session(text, text, text, text);
