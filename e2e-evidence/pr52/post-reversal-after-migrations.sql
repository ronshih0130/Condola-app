-- Run after every file in supabase/migrations, in filename order.
-- The last two are 20261030160000_rent_settlement.sql and
-- 20261030170000_payment_settlement_rules.sql, both after 20261030150000.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f e2e-evidence/pr52/post-reversal-after-migrations.sql
--
-- Fails if any non-extension public function is executable by anon, or if
-- cross-org post_reversal does not raise 42501 (transaction org mismatch).
-- The cross-org call is rolled back and writes nothing.

\set ON_ERROR_STOP on

DO $anon$
DECLARE
  anon_count integer;
  sample text;
BEGIN
  SELECT count(*),
         string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    INTO anon_count, sample
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1
        FROM pg_depend d
       WHERE d.objid = p.oid
         AND d.classid = 'pg_proc'::regclass
         AND d.deptype = 'e'
    );
  IF anon_count <> 0 THEN
    RAISE EXCEPTION 'anon executable public functions: % (%)', anon_count, sample;
  END IF;
END
$anon$;

DO $shape$
DECLARE
  def text;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'post_reversal'
       AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'post_reversal is SECURITY DEFINER';
  END IF;

  SELECT string_agg(pg_get_functiondef(p.oid), E'\n')
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'post_reversal';

  IF def IS NULL
     OR def NOT LIKE '%reversal_target_exists%'
     OR def NOT LIKE '%app.is_member%'
     OR def NOT LIKE '%app.active_org_id%'
     OR def NOT LIKE '%42501%'
     OR def NOT LIKE '%transaction org mismatch%'
  THEN
    RAISE EXCEPTION 'post_reversal lost the org-scoped reversal body';
  END IF;

  IF has_function_privilege('anon', 'public.post_reversal(uuid, text)', 'EXECUTE')
     OR has_function_privilege('public', 'public.post_reversal(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.post_reversal(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.post_reversal(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.post_reversal(uuid, text, uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'public.post_reversal(uuid, text, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.post_reversal(uuid, text, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.post_reversal(uuid, text, uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'post_reversal EXECUTE is not limited to authenticated and service_role';
  END IF;
END
$shape$;

BEGIN;

DO $pick$
DECLARE
  org_a uuid := '10000000-0000-4000-8000-000000000001';
  org_b uuid := '10000000-0000-4000-8000-000000000002';
  user_b uuid := '20000000-0000-4000-8000-000000000009';
  txn uuid;
BEGIN
  SELECT id INTO txn FROM ledger_transactions WHERE org_id = org_a LIMIT 1;
  IF txn IS NULL THEN
    RAISE EXCEPTION 'no ledger row in org % for the cross-org post_reversal check', org_a;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', user_b::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('app.active_org_id', org_b::text, true);
  PERFORM set_config('pr52.txn', txn::text, true);
END
$pick$;

SET LOCAL ROLE authenticated;

DO $cross$
DECLARE
  txn uuid := nullif(current_setting('pr52.txn', true), '')::uuid;
BEGIN
  IF txn IS NULL THEN
    RAISE EXCEPTION 'cross-org target was not pinned';
  END IF;
  BEGIN
    PERFORM post_reversal(txn, 'cross-org check');
    RAISE EXCEPTION 'cross-org post_reversal did not raise';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLSTATE <> '42501' OR SQLERRM NOT LIKE '%org mismatch%' THEN
        RAISE EXCEPTION 'expected 42501 transaction org mismatch, got % %', SQLSTATE, SQLERRM;
      END IF;
  END;
  BEGIN
    PERFORM post_reversal(txn, 'cross-org check', NULL::uuid);
    RAISE EXCEPTION 'cross-org post_reversal(uuid, text, uuid) did not raise';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLSTATE <> '42501' OR SQLERRM NOT LIKE '%org mismatch%' THEN
        RAISE EXCEPTION 'expected 42501 transaction org mismatch, got % %', SQLSTATE, SQLERRM;
      END IF;
  END;
END
$cross$;

ROLLBACK;
