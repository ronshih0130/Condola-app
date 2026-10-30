BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Preserve the existing positive-invoice guard; a zero first invoice has
-- actual zero lines and no posting, allocation or amount due.
CREATE OR REPLACE FUNCTION app.b001_require_completion_financials() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.leases l JOIN public.invoices i ON i.org_id=l.org_id AND i.lease_id=l.id
    WHERE l.id=NEW.lease_id AND l.org_id=NEW.org_id AND l.status='active'
      AND i.source='move_in' AND i.status <> 'void'
      AND EXISTS (SELECT 1 FROM public.audit_log a WHERE a.org_id=NEW.org_id AND a.actor_user_id=NEW.actor_id AND a.event_type='esign_lease_activated'
        AND a.table_name='leases' AND a.row_id=l.id::text AND a.new_row->>'invoice_id'=i.id::text
        AND a.new_row->>'case_id'=NEW.case_id::text AND a.new_row->>'version_id'=NEW.version_id::text
        AND a.new_row->>'case_creator_id'=NEW.case_creator_id::text)
      AND (
        (i.total_minor = 0 AND i.paid_minor = 0 AND i.balance_minor = 0 AND i.ledger_transaction_id IS NULL
          AND EXISTS (SELECT 1 FROM public.invoice_lines il WHERE il.invoice_id=i.id)
          AND (SELECT sum(il.amount_minor) FROM public.invoice_lines il WHERE il.invoice_id=i.id)=0
          AND NOT EXISTS (SELECT 1 FROM public.invoice_lines il WHERE il.invoice_id=i.id AND il.amount_minor <> 0)
          AND NOT EXISTS (SELECT 1 FROM public.payment_allocations pa WHERE pa.invoice_id=i.id)
          AND NOT EXISTS (SELECT 1 FROM public.ledger_entries e WHERE e.invoice_id=i.id)
          AND NOT EXISTS (SELECT 1 FROM public.ledger_transactions t WHERE t.org_id=i.org_id AND t.source_table='invoices' AND t.source_id=i.id)
          AND EXISTS (SELECT 1 FROM public.audit_log a WHERE a.org_id=NEW.org_id AND a.actor_user_id=NEW.actor_id
            AND a.event_type='esign_lease_activated' AND a.table_name='leases' AND a.row_id=l.id::text
            AND a.new_row->>'invoice_id'=i.id::text AND a.new_row->>'case_id'=NEW.case_id::text
            AND a.new_row->>'version_id'=NEW.version_id::text AND a.new_row->>'case_creator_id'=NEW.case_creator_id::text
            AND a.new_row->'no_amount_due'='true'::jsonb))
        OR
        (i.total_minor > 0 AND EXISTS (
          SELECT 1 FROM public.ledger_transactions t WHERE t.id=i.ledger_transaction_id AND t.org_id=i.org_id
            AND t.source_table='invoices' AND t.source_id=i.id
            AND EXISTS (SELECT 1 FROM public.ledger_entries e WHERE e.transaction_id=t.id AND e.invoice_id=i.id AND e.account='tenant_receivable')
            AND (NOT EXISTS (SELECT 1 FROM public.invoice_lines il WHERE il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor > 0)
              OR EXISTS (SELECT 1 FROM public.ledger_entries e WHERE e.transaction_id=t.id AND e.invoice_id=i.id AND e.account='rental_income'))))
      )
  ) THEN RAISE EXCEPTION 'Signing completion requires activation and first invoice' USING ERRCODE='23514'; END IF;
  DELETE FROM app.b001_completion_requirements WHERE version_id=NEW.version_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.b001_require_completion_financials() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
