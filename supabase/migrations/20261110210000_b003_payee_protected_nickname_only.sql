-- B-1 (CB2 / MGT-04 / TEN-06): on an assigned/protected payee account, legacy,
-- accountant and service_role writes may change ONLY nickname and updated_at.
-- bank_code, branch_code, bank_name, account_last5, currency, show_to_tenants
-- and any other column must be rejected with 42501 so tenant-visible payee bank
-- details can only change through the audited, admin-only gateway.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION app.payee_bank_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user NOT IN ('anon','authenticated','service_role') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_default_payee OR NEW.holder_name IS NOT NULL OR NEW.country_code IS NOT NULL OR NEW.details <> '{}'::jsonb THEN
      RAISE EXCEPTION 'payee account requires gateway' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF app.payee_bank_is_protected(OLD.org_id,OLD.id) OR OLD.is_default_payee OR OLD.holder_name IS NOT NULL THEN
    -- DELETE of a protected/payee row always needs the gateway.
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'payee account requires gateway' USING ERRCODE = '42501';
    END IF;
    -- B-1: allow a legacy UPDATE only when the changed columns are all in
    -- ('nickname','updated_at'). Any other change -- bank_name, bank_code,
    -- branch_code, account_last5, currency, show_to_tenants, payee fields,
    -- identity/property/archive moves, is_default_payee, or any later-added
    -- column -- still needs the audited admin-only gateway.
    IF EXISTS (
      SELECT 1 FROM jsonb_each(to_jsonb(NEW)) AS n
      WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key)
        AND n.key NOT IN ('nickname','updated_at')
    ) THEN
      RAISE EXCEPTION 'payee account requires gateway' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.is_default_payee OR NEW.holder_name IS NOT NULL OR NEW.country_code IS DISTINCT FROM OLD.country_code OR NEW.details IS DISTINCT FROM OLD.details THEN
    RAISE EXCEPTION 'payee account requires gateway' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.payee_bank_guard() FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
