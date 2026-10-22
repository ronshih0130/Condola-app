-- Version 20261029170000. After 20261029150000_lock_public_function_execute.sql.
-- Additive. Both post_reversal overloads stay. service_role is unchanged.
--
-- 20261029150000 already replaces post_reversal(uuid, text). This file replaces
-- it again because that body is not the same:
--   * 29150000 checks only current_user = 'authenticated', compares the pin to
--     org_id, and raises 42501 for every missing SELECT (hidden row and unknown
--     id look the same). search_path is public, pg_temp. It does not call
--     app.is_member.
--   * This body also checks anon, requires app.is_member(t.org_id), and uses
--     app.reversal_target_exists so a row hidden by RLS raises 42501 while a
--     missing id stays "transaction % not found". search_path is
--     pg_catalog, public, pg_temp.
-- The 3-arg overload is not replaced in 29150000 (that file only revokes
-- EXECUTE). The org check below is new: cross-org calls raise 42501.
-- app.audit_event records the session org. A p_org that differs is 42501.
--
-- post_reversal stays SECURITY INVOKER, so current_user is the real role and a
-- caller cannot spoof service_role through request.jwt.claim.role. RLS hides a
-- foreign ledger row from authenticated, which would otherwise look like a
-- missing transaction. The definer lookup below only answers "does this id
-- exist" so the invoker can raise 42501 instead.

CREATE OR REPLACE FUNCTION app.reversal_target_exists(p_txn uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.ledger_transactions WHERE id = p_txn);
$$;

REVOKE ALL ON FUNCTION app.reversal_target_exists(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.reversal_target_exists(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION post_reversal(p_txn uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  t ledger_transactions;
  new_id uuid;
  posted_on date;
BEGIN
  SELECT * INTO t FROM ledger_transactions WHERE id = p_txn;
  IF NOT FOUND THEN
    IF app.reversal_target_exists(p_txn) AND current_user IN ('authenticated', 'anon') THEN
      RAISE EXCEPTION 'transaction org mismatch' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'transaction % not found', p_txn;
  END IF;
  IF current_user IN ('authenticated', 'anon') THEN
    IF t.org_id::text IS DISTINCT FROM nullif(current_setting('app.active_org_id', true), '')
       OR NOT app.is_member(t.org_id) THEN
      RAISE EXCEPTION 'transaction org mismatch' USING ERRCODE = '42501';
    END IF;
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
END $$;

CREATE OR REPLACE FUNCTION post_reversal(p_txn uuid, p_reason text, p_invoice uuid) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE t ledger_transactions; new_id uuid;
BEGIN
  SELECT * INTO t FROM ledger_transactions WHERE id = p_txn;
  IF NOT FOUND THEN
    IF app.reversal_target_exists(p_txn) AND current_user IN ('authenticated', 'anon') THEN
      RAISE EXCEPTION 'transaction org mismatch' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'transaction % not found', p_txn;
  END IF;
  IF current_user IN ('authenticated', 'anon') THEN
    IF t.org_id::text IS DISTINCT FROM nullif(current_setting('app.active_org_id', true), '')
       OR NOT app.is_member(t.org_id) THEN
      RAISE EXCEPTION 'transaction org mismatch' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_invoice IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM invoices WHERE id = p_invoice AND org_id = t.org_id
  ) THEN
    RAISE EXCEPTION 'credit invoice % is not in the transaction organization', p_invoice
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  INSERT INTO ledger_transactions (org_id, property_id, lease_id, kind, currency, effective_date, description,
                                   source_table, source_id, reverses_transaction_id, reason, created_by)
  VALUES (t.org_id, t.property_id, t.lease_id, 'reversal', t.currency, (timezone('Asia/Taipei', now()))::date,
          'Reversal of '||t.id, t.source_table, t.source_id, t.id, p_reason, auth.uid())
  RETURNING id INTO new_id;
  INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id, memo)
  SELECT org_id, new_id, account, -amount_minor, currency, contact_id, property_id, lease_id,
         COALESCE(p_invoice, invoice_id), 'reversal'
    FROM ledger_entries WHERE transaction_id = p_txn;
  RETURN new_id;
END $$;

REVOKE ALL ON FUNCTION post_reversal(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION post_reversal(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION post_reversal(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION post_reversal(uuid, text, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION app.audit_event(p_org uuid, p_event text, p_detail jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_org uuid;
  v_run uuid;
  v_status allocation_status;
  v_approved uuid;
  v_voided uuid;
  v_lines int;
  v_reversed int;
  v_computed timestamptz;
  v_row jsonb;
  v_active text;
BEGIN
  v_active := nullif(current_setting('app.active_org_id', true), '');
  IF v_active IS NULL THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  v_org := v_active::uuid;
  IF p_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NULL OR NOT app.has_role(v_org, '{admin,manager}') THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;
  IF p_event NOT IN ('utility_charge_posted', 'utility_charge_reposted', 'utility_charge_voided') THEN
    RAISE EXCEPTION 'event not allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF p_detail IS NULL OR jsonb_typeof(p_detail) <> 'object' THEN
    RAISE EXCEPTION 'audit detail must be an object' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_detail) AS k(key)
     WHERE k.key NOT IN ('runId', 'lines', 'reversed')
  ) THEN
    RAISE EXCEPTION 'audit detail has unknown keys' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (p_detail ? 'runId') OR jsonb_typeof(p_detail->'runId') <> 'string' THEN
    RAISE EXCEPTION 'audit detail needs runId' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    v_run := (p_detail->>'runId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'audit runId is not a uuid' USING ERRCODE = 'check_violation';
  END;
  IF p_detail ? 'lines' THEN
    IF jsonb_typeof(p_detail->'lines') <> 'number'
       OR (p_detail->>'lines') !~ '^[0-9]+$'
       OR length(p_detail->>'lines') > 4
       OR (p_detail->>'lines')::int > 1000 THEN
      RAISE EXCEPTION 'audit lines out of range' USING ERRCODE = 'check_violation';
    END IF;
    v_lines := (p_detail->>'lines')::int;
  END IF;
  IF p_detail ? 'reversed' THEN
    IF jsonb_typeof(p_detail->'reversed') <> 'number'
       OR (p_detail->>'reversed') !~ '^[0-9]+$'
       OR length(p_detail->>'reversed') > 4
       OR (p_detail->>'reversed')::int > 1000 THEN
      RAISE EXCEPTION 'audit reversed out of range' USING ERRCODE = 'check_violation';
    END IF;
    v_reversed := (p_detail->>'reversed')::int;
  END IF;
  IF p_detail ? 'lines' AND p_detail ? 'reversed' AND v_reversed > v_lines THEN
    RAISE EXCEPTION 'audit reversed exceeds lines' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, approved_by, voided_by, computed_at
    INTO v_status, v_approved, v_voided, v_computed
    FROM utility_allocation_runs
   WHERE id = v_run AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation run is not in this organization' USING ERRCODE = 'check_violation';
  END IF;
  IF p_event = 'utility_charge_voided' THEN
    IF v_status <> 'void' OR v_voided IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'void audit does not match the run' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_status <> 'posted' OR v_approved IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'post audit does not match the run' USING ERRCODE = 'check_violation';
  END IF;
  IF p_event = 'utility_charge_posted' AND EXISTS (
    SELECT 1 FROM audit_log a
     WHERE a.org_id = v_org
       AND a.event_type = 'utility_charge_posted'
       AND a.new_row->>'runId' = v_run::text
  ) THEN
    RAISE EXCEPTION 'posted audit already recorded for this run' USING ERRCODE = 'check_violation';
  END IF;
  IF p_event = 'utility_charge_reposted' AND EXISTS (
    SELECT 1 FROM audit_log a
     WHERE a.org_id = v_org
       AND a.event_type = 'utility_charge_reposted'
       AND a.new_row->>'runId' = v_run::text
       AND a.occurred_at >= v_computed
  ) THEN
    RAISE EXCEPTION 'reposted audit already recorded for this run' USING ERRCODE = 'check_violation';
  END IF;
  v_row := jsonb_build_object('event', p_event, 'runId', v_run);
  IF p_detail ? 'lines' THEN
    v_row := v_row || jsonb_build_object('lines', v_lines);
  END IF;
  IF p_detail ? 'reversed' THEN
    v_row := v_row || jsonb_build_object('reversed', v_reversed);
  END IF;
  INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, new_row, reason)
  VALUES (v_org, auth.uid(), 'app', 'auth_events', p_event, 'insert', p_event, v_row, p_event);
END $$;

REVOKE ALL ON FUNCTION app.audit_event(uuid, text, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION app.audit_event(uuid, text, jsonb) TO authenticated;
