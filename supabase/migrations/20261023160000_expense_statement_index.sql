-- Version 20261023160000.
-- Staff lists and owner statements both keep approved/posted owner charges.
-- draft, submitted, rejected, and void stay out of the monthly statement.
-- Repair records may insert a draft with expenses.ticket_id set. Approving that
-- draft posts the row and does not clear the ticket link.

CREATE INDEX IF NOT EXISTS expenses_statement_idx
  ON expenses (org_id, incurred_on, property_id)
  WHERE status IN ('approved','posted') AND bill_to = 'owner';

COMMENT ON COLUMN expenses.status IS
  'Owner monthly statements include approved and posted rows with bill_to = owner. draft, submitted, rejected, and void are excluded. A repair draft stays linked by ticket_id until staff approve it.';
