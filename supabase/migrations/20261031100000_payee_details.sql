-- Additive: old INSERT column lists remain valid; no existing rows are updated.
ALTER TABLE public.bank_accounts
  ADD COLUMN holder_name text CHECK (char_length(holder_name) <= 200),
  ADD COLUMN account_number text CHECK (account_number ~ '^[A-Za-z0-9 -]{1,34}$'),
  ADD COLUMN country_code char(2) CHECK (country_code ~ '^[A-Z]{2}$'),
  ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object'),
  ADD COLUMN is_default_payee boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_at timestamptz;

CREATE UNIQUE INDEX bank_accounts_one_default_payee
  ON public.bank_accounts (org_id)
  WHERE is_default_payee AND archived_at IS NULL;

ALTER TABLE public.leases
  ADD COLUMN payee_bank_account_id uuid,
  ADD CONSTRAINT leases_payee_bank_account_fk
    FOREIGN KEY (org_id, payee_bank_account_id)
    REFERENCES public.bank_accounts (org_id, id);

CREATE FUNCTION app.sync_payee_account_last5()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  digits text;
BEGIN
  digits := regexp_replace(NEW.account_number, '[^0-9]', '', 'g');
  IF length(digits) >= 5 THEN
    NEW.account_last5 := right(digits, 5);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.sync_payee_account_last5()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER sync_payee_account_last5
  BEFORE INSERT OR UPDATE ON public.bank_accounts
  FOR EACH ROW EXECUTE FUNCTION app.sync_payee_account_last5();

-- Audit: bank_accounts and leases already carry the generic fn_audit trigger
-- (trg_bank_accounts_audit, trg_leases_audit), which records every insert/update
-- of the new columns in the admin-only audit_log. No extra audit trigger needed.
