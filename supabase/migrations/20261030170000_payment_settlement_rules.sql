-- Version 20261030170000. After 20261030160000_rent_settlement.sql.
-- Payment and owner-settlement rules.
--
-- Additive on existing tables: new nullable columns only.
-- No new NOT NULL, CHECK, foreign key, or column default is added to an existing table.
-- leases.due_day keeps its existing default.
-- statement_change_log and owner_payouts are new tables. Safe to apply again.
--
-- post_reversal is restated from 20261030120000_org_scoped_reversal_audit.sql
-- so this later file cannot replace that body. Both overloads stay
-- SECURITY INVOKER. A row hidden by RLS still raises 42501 through
-- app.reversal_target_exists. A missing id stays "transaction % not found".
-- app.is_member and app.active_org_id still reject a cross-org caller.
-- The settlement columns in this file are not written by post_reversal;
-- the insert is the #47 body. app.audit_event is not replaced.
--
-- Invoice and lease trigger functions are not altered. 20261030100000 and
-- 20261030150000 already revoked their EXECUTE, and this file does not
-- grant it back.
--
-- Each replaced function ends with REVOKE EXECUTE FROM PUBLIC, anon and
-- GRANT EXECUTE TO authenticated, service_role, matching the helper
-- pattern in 20261030100000_lock_public_function_execute.sql.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS payee text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS charge_kind text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS period text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reverse_reason text;

ALTER TABLE owner_statements ADD COLUMN IF NOT EXISTS firm_handled_minor bigint;
ALTER TABLE owner_statements ADD COLUMN IF NOT EXISTS changed_after_generate boolean DEFAULT false;
ALTER TABLE owner_statements ADD COLUMN IF NOT EXISTS content_snapshot jsonb;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS records_only boolean DEFAULT false;

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

REVOKE ALL ON TABLE statement_change_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE statement_change_log TO authenticated;
GRANT SELECT, INSERT ON TABLE statement_change_log TO service_role;

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

REVOKE ALL ON TABLE owner_payouts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE owner_payouts TO authenticated;
GRANT SELECT, INSERT ON TABLE owner_payouts TO service_role;

-- Restate 20261030120000. Hidden RLS row: 42501. Missing id: not found.
-- authenticated and anon must match app.active_org_id and app.is_member.
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

REVOKE EXECUTE ON FUNCTION post_reversal(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION post_reversal(uuid, text) TO authenticated, service_role;

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

REVOKE EXECUTE ON FUNCTION post_reversal(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION post_reversal(uuid, text, uuid) TO authenticated, service_role;
