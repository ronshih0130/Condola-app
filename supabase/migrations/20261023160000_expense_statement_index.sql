-- Version 20261023160000.
-- Staff lists and owner statements both keep approved/posted owner charges.
-- draft, submitted, rejected, and void stay out of the monthly statement.
-- Repair records may insert a draft with expenses.ticket_id set. Approving that
-- draft posts the row and does not clear the ticket link.

CREATE INDEX IF NOT EXISTS expenses_statement_idx
  ON expenses (org_id, incurred_on, property_id)
  WHERE status IN ('approved','posted') AND bill_to = 'owner';

COMMENT ON COLUMN expenses.status IS
  'Owner monthly statements include approved and posted rows with bill_to = owner. draft, submitted, rejected, and void are excluded. A repair draft keeps ticket_id until staff approve it. Voiding a row that is not on an issued statement clears ticket_id so the repair can file another draft.';

-- Closed months and issued statements are enforced here, not only in the app.
CREATE OR REPLACE FUNCTION fn_expense_locks() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  closed date;
  issued boolean;
  org uuid;
  incurred date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    org := OLD.org_id;
    incurred := OLD.incurred_on;
  ELSE
    org := NEW.org_id;
    incurred := NEW.incurred_on;
  END IF;

  -- Lock the close row this check uses so a concurrent close cannot move under us.
  SELECT period_month INTO closed
    FROM month_closes
   WHERE org_id = org
   ORDER BY period_month DESC
   LIMIT 1
   FOR SHARE;

  IF closed IS NOT NULL AND to_char(incurred, 'YYYY-MM') <= to_char(closed, 'YYYY-MM') THEN
    RAISE EXCEPTION 'month is closed' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE'
     AND closed IS NOT NULL
     AND to_char(OLD.incurred_on, 'YYYY-MM') <= to_char(closed, 'YYYY-MM') THEN
    RAISE EXCEPTION 'month is closed' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (
      SELECT 1
        FROM owner_statement_lines l
        JOIN owner_statements s ON s.id = l.statement_id
       WHERE l.expense_id = NEW.id
         AND s.org_id = NEW.org_id
         AND s.status <> 'void'
    ) INTO issued;
    IF issued AND (
      NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
      OR NEW.incurred_on IS DISTINCT FROM OLD.incurred_on
      OR NEW.property_id IS DISTINCT FROM OLD.property_id
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.bill_to IS DISTINCT FROM OLD.bill_to
      OR (NEW.status = 'void' AND OLD.status IS DISTINCT FROM 'void')
    ) THEN
      RAISE EXCEPTION 'expense is on an issued statement' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_expense_locks ON expenses;
CREATE TRIGGER trg_expense_locks
  BEFORE INSERT OR UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION fn_expense_locks();

-- Reversals use the Taipei calendar date rather than the database session date.
CREATE OR REPLACE FUNCTION post_reversal(p_txn uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  t ledger_transactions;
  new_id uuid;
  posted_on date;
BEGIN
  SELECT * INTO t FROM ledger_transactions WHERE id = p_txn;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction % not found', p_txn; END IF;
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
