-- Version 20261028160000.
-- Staging is one database for every preview. 20261028130000 already added
-- utility_allocation_runs_open_period_uidx and utility_allocation_runs_unit_period_excl
-- on every non-void run, and unit_id NOT NULL. Lease create on main always
-- INSERTs a draft (no unit_id) and then inserts a recomputed line for every
-- room. The second lease in that meter and period hit 23505 and the lease
-- rolled back.
--
-- The unique index and the exclusion constraint stay as they are, including
-- drafts. Dropping drafts from either one would leave two live runs, and
-- confirming both would post 電費 twice. This trigger keeps a single non-void
-- run for an exact period:
--   * a previous draft is voided, and its vacant-room expense is reversed,
--     so the new insert can land; the caller then writes the replacement lines;
--   * an approved, posted, or pending_repost run is not rewritten. The new
--     insert is stored as void, so the lease still commits and nothing is
--     double-posted. Lines the caller adds hang off that void run.
-- Overlapping but unequal periods still raise the exclusion error. This insert
-- rebuilds only its own dates, so voiding a different review would drop it.

CREATE OR REPLACE FUNCTION public.utility_runs_reuse_open_period()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  existing utility_allocation_runs%ROWTYPE;
  actor uuid;
  expense_id uuid;
  ledger_id uuid;
BEGIN
  IF NEW.status IS DISTINCT FROM 'draft' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('utility-run'),
    hashtext(NEW.meter_id::text || '|' || NEW.period_start::text || '|' || NEW.period_end::text)
  );

  SELECT * INTO existing
    FROM utility_allocation_runs
   WHERE meter_id = NEW.meter_id
     AND period_start = NEW.period_start
     AND period_end = NEW.period_end
     AND status <> 'void'
   ORDER BY computed_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  actor := coalesce(NEW.computed_by, existing.computed_by, existing.approved_by, existing.voided_by);
  IF actor IS NULL THEN
    RAISE EXCEPTION 'utility run % for this meter and period is already %, and this insert has no user to record'
      , existing.id, existing.status
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'utility_allocation_runs_open_period_uidx';
  END IF;

  IF existing.status <> 'draft' THEN
    NEW.status := 'void';
    NEW.void_reason := '這一期的電費已經確認，這次建立沒有改那次分攤';
    NEW.voided_by := actor;
    NEW.voided_at := now();
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM utility_allocation_lines
     WHERE run_id = existing.id AND posted_ledger_transaction_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'draft utility run % already has posted lines'
      , existing.id
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'utility_allocation_runs_open_period_uidx';
  END IF;

  PERFORM set_config('app.change_reason', '同期分攤改由新草稿取代', true);

  FOR expense_id, ledger_id IN
    SELECT e.id, e.ledger_transaction_id
      FROM expenses e
     WHERE e.org_id = existing.org_id
       AND e.utility_run_id = existing.id
       AND e.status <> 'void'
     FOR UPDATE
  LOOP
    IF ledger_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM ledger_transactions WHERE reverses_transaction_id = ledger_id
    ) THEN
      PERFORM post_reversal(ledger_id, '作廢空房電費');
    END IF;
    UPDATE expenses
       SET status = 'void'
     WHERE id = expense_id
       AND status <> 'void';
  END LOOP;

  DELETE FROM utility_allocation_lines
   WHERE run_id = existing.id
     AND posted_ledger_transaction_id IS NULL;

  UPDATE utility_allocation_runs
     SET status = 'void',
         void_reason = '同期已有新的草稿，這次分攤改由新草稿取代',
         voided_by = actor,
         voided_at = now()
   WHERE id = existing.id
     AND status = 'draft';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_b_reuse_open_period ON utility_allocation_runs;
CREATE TRIGGER trg_b_reuse_open_period
  BEFORE INSERT ON utility_allocation_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.utility_runs_reuse_open_period();

GRANT EXECUTE ON FUNCTION public.utility_runs_reuse_open_period() TO authenticated, service_role;
