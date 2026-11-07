-- S3 BLK-MAC-17: replace single-shot table-level `LOCK TABLE ... NOWAIT` admission
-- locks with a bounded acquisition, so a concurrent (auto)vacuum / auto-analyze no
-- longer turns every affected gateway into an immediate 55P03 "busy".
--
-- Why: autovacuum and auto-analyze hold SHARE UPDATE EXCLUSIVE (conflicts with
-- SHARE) and vacuum's heap-truncation phase briefly holds ACCESS EXCLUSIVE
-- (conflicts with every mode). PostgreSQL cancels a non-wraparound autovacuum
-- worker, and vacuum gives up truncation, only when another backend is *queued*
-- on the lock (autovacuum: after that waiter's deadlock_timeout). A single NOWAIT
-- attempt never queues and never retries, so the caller failed at once.
--
-- Two strategies, chosen per call site:
-- (A) app.lock_tables_bounded(tables, mode): a real, bounded wait. Function-scoped
--     lock_timeout max(2s, deadlock_timeout + 1s), so a regular autovacuum is
--     cancelled (and truncation abandoned) before the bound; the SET clause
--     restores the caller's own lock_timeout on exit, also on error. Timeout = the
--     native 55P03; a deadlock resolved against this waiter is re-raised as 55P03.
-- (B) app.lock_tables_nowait_retry(tables, mode): bounded NOWAIT retry (20-50ms
--     jittered sleeps, ~2s budget, then the original 55P03), matching the B-010 r3
--     polling approach. It never queues, so it adds no waiting edge (cannot close a
--     lock cycle) and never makes later writers queue behind it. Used for every
--     SHARE-mode (writer-conflicting) request that can be reached while the
--     transaction already holds row/write locks: the triggers b017_old_source_insert,
--     b017_occurrence_valid, b028_center_recipient_valid, b017_resolution_admit ("never
--     waits on a late admission edge"), b028_center_session's contacts lock (after
--     b028_center_context row pins and cursor deletes) and b013_owner_view's
--     regional_defaults lock (after b013_owner_context row pins). It rides out a short
--     autovacuum/truncation; it does not make one yield.
--     (A) remains only where the request is the transaction's first SHARE acquisition
--     before any row/write lock (top-level gateways), or is ACCESS SHARE / ROW
--     EXCLUSIVE, which ordinary writers (ROW EXCLUSIVE) neither block nor queue behind.
-- Either way every existing 55P03 -> busy mapping is unchanged.
--
-- Each listed function is re-created from its current definition with only its
-- NOWAIT table-lock statements replaced, in place and in the same order; the patch
-- fails closed on any count/ownership mismatch. Owners, grants, SECURITY DEFINER,
-- proconfig (search_path / lock_timeout) and all row-level NOWAIT locks are unchanged.
--
-- (C) Not changed: the three B-010 r3 / BLK-MAC-11 polling functions
-- (b010_fence_legacy_reminders, b010_guard_payment_transition,
-- b010_lock_payment_context) already poll NOWAIT within a ~6s budget.
-- Residual: an anti-wraparound autovacuum is never auto-cancelled; callers then get
-- a bounded 55P03 after the wait/budget. No table, column, grant, flag or data change.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION app.lock_tables_bounded(p_tables regclass[], p_mode text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE v_list text; v_bound_ms bigint;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN ('ACCESS SHARE','ROW EXCLUSIVE','SHARE') THEN
  RAISE EXCEPTION 'unsupported lock mode' USING ERRCODE = '22023';
 END IF;
 IF p_tables IS NULL OR cardinality(p_tables) = 0 OR array_position(p_tables, NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'lock target required' USING ERRCODE = '22023';
 END IF;
 -- The bound must exceed deadlock_timeout so a regular autovacuum is cancelled
 -- (by this waiter's deadlock check) before the bound expires.
 SELECT greatest(2000, s.setting::bigint + 1000) INTO v_bound_ms FROM pg_settings s WHERE s.name = 'deadlock_timeout';
 IF v_bound_ms IS DISTINCT FROM 2000 THEN
  PERFORM set_config('lock_timeout', coalesce(v_bound_ms, 2000)::text || 'ms', true);
 END IF;
 -- search_path=pg_catalog: regclass output is always schema-qualified and quoted.
 SELECT string_agg(t.rel::text, ', ' ORDER BY t.ord) INTO v_list FROM unnest(p_tables) WITH ORDINALITY AS t(rel, ord);
 BEGIN
  EXECUTE format('LOCK TABLE %s IN %s MODE', v_list, p_mode);
 EXCEPTION WHEN deadlock_detected THEN
  RAISE EXCEPTION 'could not obtain lock on relation %: deadlock while waiting', v_list USING ERRCODE = '55P03';
 END;
END $$;
REVOKE ALL ON FUNCTION app.lock_tables_bounded(regclass[], text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.lock_tables_nowait_retry(p_tables regclass[], p_mode text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_list text; v_deadline timestamptz := clock_timestamp() + interval '2 seconds'; v_remaining double precision;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN ('ACCESS SHARE','ROW EXCLUSIVE','SHARE') THEN
  RAISE EXCEPTION 'unsupported lock mode' USING ERRCODE = '22023';
 END IF;
 IF p_tables IS NULL OR cardinality(p_tables) = 0 OR array_position(p_tables, NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'lock target required' USING ERRCODE = '22023';
 END IF;
 SELECT string_agg(t.rel::text, ', ' ORDER BY t.ord) INTO v_list FROM unnest(p_tables) WITH ORDINALITY AS t(rel, ord);
 LOOP
  BEGIN
   -- Never queues: no waiting edge. A failed attempt's subtransaction releases
   -- any partial lock set before sleeping.
   EXECUTE format('LOCK TABLE %s IN %s MODE NOWAIT', v_list, p_mode);
   RETURN;
  EXCEPTION WHEN lock_not_available THEN
   v_remaining := extract(epoch FROM v_deadline - clock_timestamp());
   IF v_remaining <= 0 THEN RAISE; END IF;
   PERFORM pg_sleep(least(v_remaining, 0.02 + random() * 0.03));
  END;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.lock_tables_nowait_retry(regclass[], text) FROM PUBLIC, anon, authenticated, service_role;

-- Exact current signatures and, per NOWAIT table-lock statement in source order
-- (latest definitions as of 20261107120000), the strategy that replaces it.
DO $s3_bounded_share_locks$
DECLARE
 v_targets constant jsonb := jsonb_build_object(
  'app.b010_manual_reminder(uuid,uuid,text,uuid,uuid,uuid,uuid)', jsonb_build_array('bounded'),
  'app.b010_schedule_rent(uuid,uuid,timestamp with time zone)', jsonb_build_array('bounded'),
  'app.b010_tenant_due_preference(uuid,uuid,text,uuid,uuid,boolean)', jsonb_build_array('bounded'),
  'app.b013_change_default(uuid,uuid,text,uuid,uuid,uuid,text,text,text)', jsonb_build_array('bounded', 'bounded', 'bounded'),
  'app.b013_change_override(uuid,uuid,text,uuid,uuid,uuid,text,text,text)', jsonb_build_array('bounded', 'bounded'),
  'app.b013_close_default(uuid,uuid,text,uuid,uuid,uuid)', jsonb_build_array('bounded'),
  'app.b013_close_override(uuid,uuid,text,uuid,uuid,uuid)', jsonb_build_array('bounded'),
  'app.b013_default_result(uuid,uuid,text,uuid,uuid)', jsonb_build_array('bounded'),
  'app.b013_default_status(uuid,uuid,text,uuid,uuid,uuid)', jsonb_build_array('bounded'),
  'app.b013_finish_default(uuid,uuid,text,uuid,uuid,uuid,text)', jsonb_build_array('bounded', 'bounded'),
  'app.b013_finish_override(uuid,uuid,text,uuid,uuid,uuid,text)', jsonb_build_array('bounded', 'bounded'),
  'app.b013_override_result(uuid,uuid,text,uuid,uuid)', jsonb_build_array('bounded'),
  'app.b013_override_status(uuid,uuid,text,uuid,uuid,uuid)', jsonb_build_array('bounded'),
  'app.b013_owner_context(uuid,uuid,text,uuid,uuid)', jsonb_build_array('bounded', 'bounded', 'bounded', 'bounded'),
  'app.b013_owner_view(uuid,uuid,text,uuid,uuid)', jsonb_build_array('bounded', 'nowait_retry'),
  'app.b015_edit_context(uuid,uuid,text,uuid)', jsonb_build_array('bounded'),
  'app.b017_occurrence_valid()', jsonb_build_array('nowait_retry'),
  'app.b017_old_source_insert()', jsonb_build_array('nowait_retry'),
  'app.b017_resolution_admit(uuid)', jsonb_build_array('nowait_retry'),
  'app.b028_center_context(uuid,uuid,text,uuid,text,text)', jsonb_build_array('bounded'),
  'app.b028_center_recipient_valid()', jsonb_build_array('nowait_retry'),
  'app.b028_center_session(uuid,uuid,text,uuid,text,text,uuid,uuid)', jsonb_build_array('nowait_retry'),
  'app.b028_center_vendor_context(text)', jsonb_build_array('bounded'),
  'app.b028_claim_manual(uuid,uuid,text,uuid,uuid,uuid,uuid[])', jsonb_build_array('bounded'),
  'app.b028_claim_scheduled(uuid,uuid,uuid[],timestamp with time zone)', jsonb_build_array('bounded'),
  'app.b028_delivery_enabled(uuid)', jsonb_build_array('bounded'),
  'app.b028_finish_manual(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text)', jsonb_build_array('bounded'));
 v_statement constant text := '(LOCK\s+TABLE\s+([^;]+?)\s+IN\s+(ACCESS SHARE|ROW EXCLUSIVE|SHARE)\s+MODE\s+NOWAIT\s*;)';
 v_sig text; v_spec jsonb; v_helper text; v_def text; v_new text; v_rest text; v_pos integer; v_found integer;
 v_bounded integer; v_retry integer; v_total integer := 0; v_total_retry integer := 0; m text[];
BEGIN
 FOR v_sig, v_spec IN SELECT key, value FROM jsonb_each(v_targets) ORDER BY key LOOP
  IF to_regprocedure(v_sig) IS NULL THEN
   RAISE EXCEPTION 'S3 lock bounds: expected function % is missing', v_sig;
  END IF;
  v_bounded := (SELECT count(*) FROM jsonb_array_elements_text(v_spec) x WHERE x = 'bounded');
  v_retry := (SELECT count(*) FROM jsonb_array_elements_text(v_spec) x WHERE x = 'nowait_retry');
  IF v_bounded + v_retry <> jsonb_array_length(v_spec) THEN
   RAISE EXCEPTION 'S3 lock bounds: unknown strategy for %', v_sig;
  END IF;
  -- Every target is SECURITY DEFINER; the invoker helpers then run as the
  -- target's owner, who must be able to execute them (EXECUTE is revoked above).
  IF NOT (SELECT p.prosecdef
     AND has_function_privilege(p.proowner, 'app.lock_tables_bounded(regclass[],text)', 'EXECUTE')
     AND has_function_privilege(p.proowner, 'app.lock_tables_nowait_retry(regclass[],text)', 'EXECUTE')
    FROM pg_proc p WHERE p.oid = v_sig::regprocedure) THEN
   RAISE EXCEPTION 'S3 lock bounds: % is not SECURITY DEFINER or its owner cannot execute the helpers', v_sig;
  END IF;
  v_def := pg_get_functiondef(v_sig::regprocedure);
  -- Positional rewrite: the i-th statement in source order gets the i-th strategy.
  v_rest := v_def; v_new := ''; v_found := 0;
  LOOP
   m := regexp_match(v_rest, v_statement);
   EXIT WHEN m IS NULL;
   v_pos := strpos(v_rest, m[1]);
   v_found := v_found + 1;
   v_helper := CASE v_spec->>(v_found - 1) WHEN 'bounded' THEN 'app.lock_tables_bounded'
    WHEN 'nowait_retry' THEN 'app.lock_tables_nowait_retry' END;
   IF v_helper IS NULL THEN
    RAISE EXCEPTION 'S3 lock bounds: % has more NOWAIT table-lock statements than expected (%)', v_sig, jsonb_array_length(v_spec);
   END IF;
   v_new := v_new || left(v_rest, v_pos - 1) || format('PERFORM %s(ARRAY[%s]::regclass[], %L);', v_helper,
    (SELECT string_agg(quote_literal(btrim(t.name)), ',' ORDER BY t.ord) FROM unnest(string_to_array(m[2], ',')) WITH ORDINALITY AS t(name, ord)),
    m[3]);
   v_rest := substr(v_rest, v_pos + length(m[1]));
  END LOOP;
  v_new := v_new || v_rest;
  IF v_found <> jsonb_array_length(v_spec)
   OR (SELECT count(*) FROM regexp_matches(v_new, 'PERFORM app\.lock_tables_bounded\(ARRAY\[', 'g')) <> v_bounded
   OR (SELECT count(*) FROM regexp_matches(v_new, 'PERFORM app\.lock_tables_nowait_retry\(ARRAY\[', 'g')) <> v_retry
   OR v_new ~* 'LOCK\s+TABLE[^;]*NOWAIT' THEN
   RAISE EXCEPTION 'S3 lock bounds: % has % NOWAIT table-lock statement(s), expected %', v_sig, v_found, jsonb_array_length(v_spec);
  END IF;
  EXECUTE v_new;
  v_total := v_total + v_found;
  v_total_retry := v_total_retry + v_retry;
 END LOOP;
 IF v_total <> 36 OR v_total_retry <> 6 THEN
  RAISE EXCEPTION 'S3 lock bounds: replaced % statements (% retry), expected 36 (6 retry)', v_total, v_total_retry;
 END IF;
 -- Fail closed if any other single-shot table-level NOWAIT remains in app/public.
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app','public') AND p.prosrc ~* 'LOCK\s+TABLE[^;]*NOWAIT'
    AND p.oid::regprocedure::text NOT IN ('app.b010_fence_legacy_reminders()', 'app.b010_guard_payment_transition()',
     'app.b010_lock_payment_context(uuid,uuid,text,uuid,uuid,text)', 'app.lock_tables_nowait_retry(regclass[],text)')) THEN
  RAISE EXCEPTION 'S3 lock bounds: an unlisted function still takes a NOWAIT table lock';
 END IF;
END $s3_bounded_share_locks$;
COMMIT;
