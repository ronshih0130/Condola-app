-- Additive: old INSERT column lists remain valid; no existing rows are updated.
ALTER TABLE public.bank_accounts
  ADD COLUMN holder_name text CHECK (char_length(holder_name) <= 200),
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

CREATE TABLE public.payee_account_numbers (
  bank_account_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  account_number text NOT NULL CHECK (account_number ~ '^[A-Za-z0-9 -]{1,34}$'),
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, bank_account_id)
    REFERENCES public.bank_accounts (org_id, id) ON DELETE CASCADE
);

ALTER TABLE public.payee_account_numbers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.payee_account_numbers TO authenticated;

CREATE POLICY payee_numbers_read ON public.payee_account_numbers
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.bank_accounts b
    WHERE b.org_id = payee_account_numbers.org_id
      AND b.id = payee_account_numbers.bank_account_id
  ));

CREATE POLICY payee_numbers_admin_insert ON public.payee_account_numbers
  FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, '{admin}'));

CREATE POLICY payee_numbers_admin_update ON public.payee_account_numbers
  FOR UPDATE TO authenticated
  USING (app.has_role(org_id, '{admin}'))
  WITH CHECK (app.has_role(org_id, '{admin}'));

CREATE FUNCTION app.payee_number_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  digits text;
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  digits := regexp_replace(NEW.account_number, '[^0-9]', '', 'g');
  IF length(digits) >= 5 THEN
    UPDATE public.bank_accounts
    SET account_last5 = right(digits, 5)
    WHERE id = NEW.bank_account_id AND org_id = NEW.org_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.audit_payee_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.audit_log (
    org_id, actor_user_id, actor_role, table_name, row_id, action,
    old_row, new_row, changed_cols, reason, request_id
  )
  VALUES (
    NEW.org_id, auth.uid(), current_user, 'payee_account_numbers',
    NEW.bank_account_id::text, lower(TG_OP)::public.audit_action,
    CASE WHEN TG_OP = 'UPDATE' THEN
      jsonb_build_object('account_last5',
        right(regexp_replace(OLD.account_number, '[^0-9]', '', 'g'), 5))
    END,
    jsonb_build_object('account_last5',
      right(regexp_replace(NEW.account_number, '[^0-9]', '', 'g'), 5)),
    ARRAY['account_number'],
    nullif(current_setting('app.change_reason', true), ''),
    nullif(current_setting('app.request_id', true), '')
  );
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.payee_number_sync()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.audit_payee_number()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER payee_number_sync
  BEFORE INSERT OR UPDATE ON public.payee_account_numbers
  FOR EACH ROW EXECUTE FUNCTION app.payee_number_sync();

CREATE TRIGGER audit_payee_number
  AFTER INSERT OR UPDATE ON public.payee_account_numbers
  FOR EACH ROW EXECUTE FUNCTION app.audit_payee_number();

-- Never attach generic fn_audit to payee_account_numbers: it copies full rows.
-- The existing bank_accounts audit trigger sees only account_last5.
