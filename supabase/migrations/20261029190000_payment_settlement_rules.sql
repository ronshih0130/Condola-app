-- Version 20261029190000.
-- Payment and owner-settlement rules.
--
-- Invoice recalc stays a trigger. fn_invoice_lines_changed and
-- fn_payment_status_changed are SECURITY DEFINER with a fixed search_path
-- (public, then pg_temp, so a temp object cannot shadow public). EXECUTE on
-- those trigger functions, and on fn_invoice_recalc, is revoked from PUBLIC,
-- anon, and authenticated. Trigger fire does not check EXECUTE, so a member
-- insert still recalculates. Direct calls are server-side only.
--
-- REVOKE is idempotent. The same revoke may also land in another migration;
-- applying this block again is safe, and a missing function is skipped.
--
-- Additive only on existing tables: new nullable columns and a default change.
-- No new NOT NULL, CHECK, or foreign key is added to an existing table.
-- statement_change_log and owner_payouts are new tables. Safe to apply again.

DO $$
BEGIN
  IF to_regprocedure('public.fn_invoice_recalc(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.fn_invoice_recalc(uuid) SECURITY DEFINER SET search_path = public, pg_temp;
    REVOKE EXECUTE ON FUNCTION public.fn_invoice_recalc(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.fn_invoice_recalc(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.fn_invoice_lines_changed()') IS NOT NULL THEN
    ALTER FUNCTION public.fn_invoice_lines_changed() SECURITY DEFINER SET search_path = public, pg_temp;
    REVOKE EXECUTE ON FUNCTION public.fn_invoice_lines_changed() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.fn_invoice_lines_changed() TO service_role;
  END IF;
  IF to_regprocedure('public.fn_payment_status_changed()') IS NOT NULL THEN
    ALTER FUNCTION public.fn_payment_status_changed() SECURITY DEFINER SET search_path = public, pg_temp;
    REVOKE EXECUTE ON FUNCTION public.fn_payment_status_changed() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.fn_payment_status_changed() TO service_role;
  END IF;
END $$;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS payee text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS charge_kind text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS period text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reverse_reason text;

ALTER TABLE owner_statements ADD COLUMN IF NOT EXISTS firm_handled_minor bigint;
ALTER TABLE owner_statements ADD COLUMN IF NOT EXISTS changed_after_generate boolean DEFAULT false;
ALTER TABLE owner_statements ADD COLUMN IF NOT EXISTS content_snapshot jsonb;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS records_only boolean DEFAULT false;

ALTER TABLE leases ALTER COLUMN due_day SET DEFAULT 5;

CREATE TABLE IF NOT EXISTS statement_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  statement_id uuid NOT NULL,
  action text NOT NULL,
  reason text,
  actor_user_id uuid,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, statement_id) REFERENCES owner_statements (org_id, id)
);

CREATE INDEX IF NOT EXISTS statement_change_log_stmt_idx
  ON statement_change_log (statement_id, created_at);

ALTER TABLE statement_change_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS team_read ON statement_change_log;
CREATE POLICY team_read ON statement_change_log
  FOR SELECT TO authenticated
  USING (app.is_member(org_id));

DROP POLICY IF EXISTS team_insert ON statement_change_log;
CREATE POLICY team_insert ON statement_change_log
  FOR INSERT TO authenticated
  WITH CHECK (app.is_member(org_id));

DROP TRIGGER IF EXISTS trg_statement_change_log_audit ON statement_change_log;
CREATE TRIGGER trg_statement_change_log_audit
  AFTER INSERT ON statement_change_log
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

REVOKE ALL ON TABLE statement_change_log FROM PUBLIC, anon;
GRANT SELECT, INSERT ON TABLE statement_change_log TO authenticated, service_role;
REVOKE UPDATE, DELETE ON TABLE statement_change_log FROM authenticated;

CREATE TABLE IF NOT EXISTS owner_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  owner_contact_id uuid NOT NULL,
  currency char(3) NOT NULL,
  period_start date NOT NULL,
  amount_minor bigint NOT NULL,
  note text,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);

CREATE INDEX IF NOT EXISTS owner_payouts_period_idx
  ON owner_payouts (org_id, owner_contact_id, period_start);

ALTER TABLE owner_payouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS team_read ON owner_payouts;
CREATE POLICY team_read ON owner_payouts
  FOR SELECT TO authenticated
  USING (app.is_member(org_id));

DROP POLICY IF EXISTS team_insert ON owner_payouts;
CREATE POLICY team_insert ON owner_payouts
  FOR INSERT TO authenticated
  WITH CHECK (
    app.is_member(org_id)
    AND app.has_role(org_id, '{admin,manager,accountant}'::org_role[])
  );

REVOKE ALL ON TABLE owner_payouts FROM PUBLIC, anon;
GRANT SELECT, INSERT ON TABLE owner_payouts TO authenticated, service_role;
REVOKE UPDATE, DELETE ON TABLE owner_payouts FROM authenticated;

-- Not-found is raised before the organization check, so a missing id is not 42501.
-- A null auth.uid() (service cleanup) may still reverse. Members of another org get 42501.
CREATE OR REPLACE FUNCTION post_reversal(p_txn uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t ledger_transactions;
  new_id uuid;
  posted_on date;
BEGIN
  SELECT * INTO t FROM ledger_transactions WHERE id = p_txn;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction % not found', p_txn USING ERRCODE = 'no_data_found';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT app.is_member(t.org_id) THEN
    RAISE EXCEPTION 'cross-organization reversal' USING ERRCODE = '42501';
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
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE t ledger_transactions; new_id uuid;
BEGIN
  SELECT * INTO t FROM ledger_transactions WHERE id = p_txn;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction % not found', p_txn USING ERRCODE = 'no_data_found';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT app.is_member(t.org_id) THEN
    RAISE EXCEPTION 'cross-organization reversal' USING ERRCODE = '42501';
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
