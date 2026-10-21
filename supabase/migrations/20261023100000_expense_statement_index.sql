-- Staff lists and owner statements both keep approved/posted owner charges.
-- draft, submitted, rejected, and void stay out of the monthly statement.

CREATE INDEX IF NOT EXISTS expenses_statement_idx
  ON expenses (org_id, incurred_on, property_id)
  WHERE status IN ('approved','posted') AND bill_to = 'owner';

COMMENT ON COLUMN expenses.status IS
  'Owner monthly statements include approved and posted rows with bill_to = owner. draft, submitted, rejected, and void are excluded.';
