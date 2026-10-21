-- Post a confirmed electricity allocation onto the tenant rent invoice.
-- Re-confirming the same amounts is a no-op. A changed confirmed run reverses the
-- previous ledger entry and replaces the 電費 line. Void reverses it too.
-- No new table: invoices, invoice lines, allocation rows, and the ledger already
-- enforce one organization per row. Do not edit earlier migrations.

ALTER TABLE units DROP CONSTRAINT units_electricity_method_chk;
ALTER TABLE units ADD CONSTRAINT units_electricity_method_chk
  CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'by_reading', 'shared', 'tenant_direct'));

ALTER TABLE rooms DROP CONSTRAINT rooms_electricity_method_chk;
ALTER TABLE rooms ADD CONSTRAINT rooms_electricity_method_chk
  CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'by_reading', 'shared', 'tenant_direct'));

ALTER TABLE utility_allocation_runs
  ADD COLUMN void_reason text,
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by uuid REFERENCES auth.users(id);

ALTER TABLE utility_allocation_runs
  ADD CONSTRAINT utility_allocation_runs_void_chk
  CHECK (status <> 'void' OR (void_reason IS NOT NULL AND voided_by IS NOT NULL));

ALTER TABLE utility_allocation_lines
  ADD COLUMN posted_invoice_id uuid,
  ADD COLUMN posted_invoice_line_id uuid,
  ADD COLUMN posted_ledger_transaction_id uuid,
  ADD COLUMN posted_amount_minor bigint,
  ADD COLUMN posted_description text;

ALTER TABLE utility_allocation_lines
  ADD CONSTRAINT utility_allocation_lines_posted_invoice_fk
    FOREIGN KEY (posted_invoice_id) REFERENCES invoices(id),
  ADD CONSTRAINT utility_allocation_lines_posted_line_fk
    FOREIGN KEY (posted_invoice_line_id) REFERENCES invoice_lines(id),
  ADD CONSTRAINT utility_allocation_lines_posted_ledger_fk
    FOREIGN KEY (posted_ledger_transaction_id) REFERENCES ledger_transactions(id),
  ADD CONSTRAINT utility_allocation_lines_posted_pair_chk
    CHECK (
      (posted_ledger_transaction_id IS NULL AND posted_amount_minor IS NULL AND posted_invoice_line_id IS NULL)
      OR (posted_ledger_transaction_id IS NOT NULL AND posted_amount_minor IS NOT NULL AND posted_invoice_line_id IS NOT NULL)
    );

-- Lookup for the open run of a meter period. Voided runs stay in the table.
CREATE INDEX utility_allocation_runs_open_period_idx
  ON utility_allocation_runs(meter_id, period_start, period_end)
  WHERE status <> 'void';
