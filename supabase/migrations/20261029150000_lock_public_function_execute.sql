-- Audit of existing public functions. Idempotent. A missing function is skipped
-- so a shared staging database that does not have it yet does not abort.
--
-- Does not change line_lease_picker or purge_due_identity_documents.
-- 20261021145000_exec_hotfix_rpc_functions.sql already revokes PUBLIC, anon,
-- and authenticated on those two (service_role only) and revokes PUBLIC and
-- anon on post_reversal(uuid, text) and fn_invoice_recalc(uuid). This file
-- does not grant those privileges back. CREATE OR REPLACE keeps the hotfix
-- grants, so authenticated and service_role still have EXECUTE and anon does
-- not. Each of those two gains a caller-org check: when current_user is
-- authenticated, the row's org_id must equal app.active_org_id, the setting
-- tx() sets with set_config('app.active_org_id', <org>, true) before
-- SET LOCAL ROLE authenticated. service_role does not take that branch.
--
-- (a) Trigger functions. Firing a trigger does not check EXECUTE. Revoke it
-- from PUBLIC, anon, and authenticated.
--
-- (b) effective_rule and platform_max_id_retention_days are not called from
-- src and are not referenced by an RLS policy or a view. Neither is
-- SECURITY DEFINER (schema.sql: effective_rule LANGUAGE sql STABLE;
-- platform_max_id_retention_days LANGUAGE sql STABLE). They are called from
-- trigger functions that run as the session user, not as the owner:
--   fn_lease_deposit_check and fn_allocation_rate_cap -> effective_rule
--   fn_org_retention_guard -> platform_max_id_retention_days
-- tx() uses authenticated and svc() uses service_role, so those roles keep
-- EXECUTE after PUBLIC and anon lose it. anon does not. Revoking
-- authenticated would make lease, allocation, and org-retention writes fail
-- with permission denied for function. effective_rule reads jurisdiction_rules
-- as the invoker, so rules_read (org_id IS NULL OR app.is_member) hides
-- another org's override. platform_max reads platform_settings only.
--
-- fn_org_country_setting is the body of trg_org_country_setting (BEFORE
-- INSERT OR UPDATE OF country_code, settings ON organizations). Nothing in
-- src, and no RLS policy or view, calls it. Firing the trigger does not
-- check EXECUTE, so PUBLIC, anon, and authenticated lose it.
--
-- condola_property_address_key stays executable by authenticated.
-- condola_sync_unit_address_keys is SECURITY DEFINER and does not call it;
-- it copies NEW.address_key. The callers are the invoker BEFORE triggers
-- condola_set_property_address_key and condola_set_unit_import_address_key
-- (20261026130000). Revoking authenticated makes those writes fail with
-- permission denied for function. 20261026130000 already revokes PUBLIC and
-- anon on the key function.

DO $revoke$
DECLARE
  sig text;
  triggers text[] := ARRAY[
    'public.fn_audit()',
    'public.fn_expense_locks()',
    'public.fn_org_bootstrap()',
    'public.fn_ticket_photo_attachment()',
    'public.fn_ticket_photo_limit()',
    'public.fn_allocation_line_cap_applies()',
    'public.fn_allocation_rate_cap()',
    'public.fn_append_only()',
    'public.fn_invoice_lines_changed()',
    'public.fn_lease_deposit_check()',
    'public.fn_lease_target_guard()',
    'public.fn_ledger_balanced()',
    'public.fn_meter_guard()',
    'public.fn_notification_context()',
    'public.fn_org_country_setting()',
    'public.fn_org_environment_guard()',
    'public.fn_org_retention_guard()',
    'public.fn_payment_alloc_guard()',
    'public.fn_payment_status_changed()',
    'public.fn_platform_retention_clamp()',
    'public.fn_set_updated_at()',
    'public.fn_template_version_immutable()',
    'public.fn_ticket_expense_org()',
    'public.fn_unit_mode_guard()'
  ];
BEGIN
  FOREACH sig IN ARRAY triggers LOOP
    IF to_regprocedure(sig) IS NULL THEN
      RAISE NOTICE 'skip missing function %', sig;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
  END LOOP;
END
$revoke$;

DO $helpers$
DECLARE
  sig text;
  helpers text[] := ARRAY[
    'public.effective_rule(uuid, uuid, text, date)',
    'public.platform_max_id_retention_days()'
  ];
BEGIN
  FOREACH sig IN ARRAY helpers LOOP
    IF to_regprocedure(sig) IS NULL THEN
      RAISE NOTICE 'skip missing function %', sig;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', sig);
  END LOOP;
END
$helpers$;

-- search_path on the functions that did not have one. The five SECURITY
-- DEFINER trigger functions already set search_path and are left alone.
-- fn_invoice_recalc is in this list; its body is replaced below and the
-- replacement sets the same path. post_reversal already has a path and is
-- not in this list. fn_org_country_setting is included with the other
-- trigger functions.
DO $paths$
DECLARE
  sig text;
  fns text[] := ARRAY[
    'public.fn_allocation_line_cap_applies()',
    'public.fn_allocation_rate_cap()',
    'public.fn_append_only()',
    'public.fn_invoice_lines_changed()',
    'public.fn_lease_deposit_check()',
    'public.fn_lease_target_guard()',
    'public.fn_ledger_balanced()',
    'public.fn_meter_guard()',
    'public.fn_notification_context()',
    'public.fn_org_country_setting()',
    'public.fn_org_environment_guard()',
    'public.fn_org_retention_guard()',
    'public.fn_payment_alloc_guard()',
    'public.fn_payment_status_changed()',
    'public.fn_platform_retention_clamp()',
    'public.fn_set_updated_at()',
    'public.fn_template_version_immutable()',
    'public.fn_ticket_expense_org()',
    'public.fn_unit_mode_guard()',
    'public.effective_rule(uuid, uuid, text, date)',
    'public.fn_invoice_recalc(uuid)',
    'public.platform_max_id_retention_days()'
  ];
BEGIN
  FOREACH sig IN ARRAY fns LOOP
    IF to_regprocedure(sig) IS NULL THEN
      RAISE NOTICE 'skip missing function %', sig;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', sig);
  END LOOP;
END
$paths$;

DO $reversal$
BEGIN
  IF to_regprocedure('public.post_reversal(uuid, text)') IS NULL THEN
    RAISE NOTICE 'skip missing function public.post_reversal(uuid, text)';
    RETURN;
  END IF;
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.post_reversal(p_txn uuid, p_reason text) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path = public, pg_temp
    AS $body$
    DECLARE
      t ledger_transactions;
      new_id uuid;
      posted_on date;
      v_pin text;
      v_session_org uuid;
      v_found boolean;
    BEGIN
      SELECT * INTO t FROM ledger_transactions WHERE id = p_txn;
      v_found := FOUND;
      IF current_user = 'authenticated' THEN
        -- tx() sets this before SET LOCAL ROLE authenticated. service_role skips.
        -- A hidden row (RLS) is NOT FOUND. Do not read t until a row was assigned.
        v_pin := nullif(current_setting('app.active_org_id', true), '');
        BEGIN
          v_session_org := v_pin::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          v_session_org := NULL;
        END;
        IF NOT v_found THEN
          RAISE EXCEPTION 'transaction org mismatch' USING ERRCODE = 'insufficient_privilege';
        ELSIF t.org_id IS DISTINCT FROM v_session_org THEN
          RAISE EXCEPTION 'transaction org mismatch' USING ERRCODE = 'insufficient_privilege';
        END IF;
      ELSIF NOT v_found THEN
        RAISE EXCEPTION 'transaction % not found', p_txn;
      END IF;
      posted_on := (timezone('Asia/Taipei', now()))::date;
      INSERT INTO ledger_transactions (
        org_id, property_id, lease_id, kind, currency, effective_date, description,
        source_table, source_id, reverses_transaction_id, reason, created_by
      ) VALUES (
        t.org_id, t.property_id, t.lease_id, 'reversal', t.currency, posted_on, 'Reversal of '||t.id,
        t.source_table, t.source_id, t.id, p_reason, auth.uid()
      )
      RETURNING id INTO new_id;
      INSERT INTO ledger_entries (
        org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id, memo
      )
      SELECT org_id, new_id, account, -amount_minor, currency, contact_id, property_id, lease_id, invoice_id, 'reversal'
        FROM ledger_entries WHERE transaction_id = p_txn;
      RETURN new_id;
    END
    $body$
  $fn$;
END
$reversal$;

DO $recalc$
BEGIN
  IF to_regprocedure('public.fn_invoice_recalc(uuid)') IS NULL THEN
    RAISE NOTICE 'skip missing function public.fn_invoice_recalc(uuid)';
    RETURN;
  END IF;
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.fn_invoice_recalc(p_invoice uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $body$
    DECLARE
      v_org uuid;
      v_pin text;
      v_session_org uuid;
      v_found boolean;
    BEGIN
      IF current_user = 'authenticated' THEN
        v_pin := nullif(current_setting('app.active_org_id', true), '');
        BEGIN
          v_session_org := v_pin::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          v_session_org := NULL;
        END;
        SELECT i.org_id INTO v_org FROM invoices i WHERE i.id = p_invoice;
        v_found := FOUND;
        IF NOT v_found THEN
          RAISE EXCEPTION 'invoice org mismatch' USING ERRCODE = 'insufficient_privilege';
        ELSIF v_org IS DISTINCT FROM v_session_org THEN
          RAISE EXCEPTION 'invoice org mismatch' USING ERRCODE = 'insufficient_privilege';
        END IF;
      END IF;
      UPDATE invoices i SET
        total_minor = coalesce((SELECT sum(amount_minor) FROM invoice_lines WHERE invoice_id = i.id), 0),
        paid_minor  = coalesce((SELECT sum(a.amount_minor) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                                 WHERE a.invoice_id = i.id AND p.status = 'confirmed'), 0)
      WHERE i.id = p_invoice;
      UPDATE invoices SET status = CASE
          WHEN balance_minor <= 0 AND total_minor > 0 THEN 'paid'::invoice_status
          WHEN paid_minor > 0 THEN 'partially_paid'::invoice_status
          ELSE 'open'::invoice_status END
      WHERE id = p_invoice AND status IN ('open','partially_paid','paid');
    END
    $body$
  $fn$;
END
$recalc$;

-- Utility charge posting (PR #18) is not on main at c4ea9de. Its migrations
-- are 20261028130000 (post_reversal(uuid, text, uuid), app.audit_event),
-- 20261028140000 (utility_runs_fill_unit_id), and 20261028160000
-- (utility_runs_reuse_open_period), on branch
-- cursor/utility-charge-posting-3532. Each block skips with NOTICE until the
-- function exists, then:
--   post_reversal(uuid, text, uuid): PUBLIC and anon lose EXECUTE.
--     authenticated keeps it. The utility branch calls this overload from
--     src/server/utility-posting.ts inside tx(). This file does not replace
--     the function body.
--   utility_runs_fill_unit_id and utility_runs_reuse_open_period: trigger
--     functions. Firing a trigger does not check EXECUTE, so PUBLIC, anon,
--     and authenticated lose it. The reuse body calls post_reversal(uuid, text),
--     which authenticated still has.
--   app.audit_event(uuid, text, jsonb): schema app, SECURITY DEFINER.
--     PUBLIC and anon lose EXECUTE. authenticated keeps it; the body checks
--     auth.uid() and app.has_role.
DO $utility$
BEGIN
  IF to_regprocedure('public.post_reversal(uuid, text, uuid)') IS NULL THEN
    RAISE NOTICE 'skip missing function public.post_reversal(uuid, text, uuid)';
  ELSE
    REVOKE EXECUTE ON FUNCTION public.post_reversal(uuid, text, uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.post_reversal(uuid, text, uuid) TO authenticated, service_role;
  END IF;

  IF to_regprocedure('public.utility_runs_fill_unit_id()') IS NULL THEN
    RAISE NOTICE 'skip missing function public.utility_runs_fill_unit_id()';
  ELSE
    REVOKE EXECUTE ON FUNCTION public.utility_runs_fill_unit_id() FROM PUBLIC, anon, authenticated;
  END IF;

  IF to_regprocedure('public.utility_runs_reuse_open_period()') IS NULL THEN
    RAISE NOTICE 'skip missing function public.utility_runs_reuse_open_period()';
  ELSE
    REVOKE EXECUTE ON FUNCTION public.utility_runs_reuse_open_period() FROM PUBLIC, anon, authenticated;
  END IF;

  IF to_regprocedure('app.audit_event(uuid, text, jsonb)') IS NULL THEN
    RAISE NOTICE 'skip missing function app.audit_event(uuid, text, jsonb)';
  ELSE
    REVOKE EXECUTE ON FUNCTION app.audit_event(uuid, text, jsonb) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION app.audit_event(uuid, text, jsonb) TO authenticated;
  END IF;
END
$utility$;
