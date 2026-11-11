-- CB2 (MGT-04 / TEN-06): legacy non-payee writes on a protected/assigned
-- bank_accounts row must succeed again; payee fields, identity/property/archive
-- moves and DELETE of protected rows still require the audited gateway.
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
    -- CB2: allow a legacy UPDATE only when the changed columns are all
    -- non-payee presentation fields. Any other change (payee fields,
    -- identity/property/archive moves, is_default_payee) still needs the gateway.
    IF EXISTS (
      SELECT 1 FROM jsonb_each(to_jsonb(NEW)) AS n
      WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key)
        AND n.key NOT IN ('nickname','bank_name','bank_code','branch_code','account_last5','currency','show_to_tenants','updated_at')
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
