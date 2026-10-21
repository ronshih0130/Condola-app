-- Version 20261025140000.
-- Vacant-room electricity stays off the tenant bill. The owner bears that share
-- as one posted expense per allocation run, so the monthly statement can list it.
-- A voided expense releases the run and a later post can insert a new row.

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS utility_run_id uuid;

ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_utility_run_fk;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_utility_run_fk
  FOREIGN KEY (org_id, utility_run_id)
  REFERENCES utility_allocation_runs (org_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS expenses_utility_run_live_uidx
  ON expenses (org_id, utility_run_id)
  WHERE utility_run_id IS NOT NULL AND status <> 'void';

COMMENT ON COLUMN expenses.utility_run_id IS
  'Set when this expense is the owner share of a vacant room on an electricity allocation run. At most one non-void expense per run.';
