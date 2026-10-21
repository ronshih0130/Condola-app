-- Deposit months above 2 need a trimmed reason plus who and when.
--
-- A guard already exists. Migration 20261021140000_basic_leases.sql replaced
-- fn_lease_deposit_check() and trigger trg_lease_deposit_check. For
-- draft, pending_signature, and active leases it raises
-- 'deposit of % months exceeds cap of % months' (check_violation) unless
-- deposit_override_reason is non-blank and deposit_overridden_by is set.
-- CHECK leases_deposit_override_pair keeps reason and overridden_by together.
-- That pair does not require deposit_overridden_at, and the trigger does not
-- apply to ended, terminated, or cancelled rows.
--
-- This check applies to every row: deposit_months > 2 requires a non-empty
-- trimmed reason, deposit_overridden_by, and deposit_overridden_at.
-- Fresh seed (src/server/seed.ts) inserts five leases at 2, 2, 2, 1, and 2
-- months. Sandbox sample deposits are also at most two months of rent.
-- A reseeded local database had 5 leases, 0 over two months, and 0 rows that
-- would violate. No backfill. The constraint is VALID, not NOT VALID.
-- The notice below records the count on the database being migrated
-- (0 on an empty database, before seed).

DO $$
DECLARE
  n_leases int;
  n_over int;
  n_bad int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE deposit_months > 2),
         count(*) FILTER (
           WHERE deposit_months > 2
             AND (
               deposit_override_reason IS NULL
               OR btrim(deposit_override_reason) = ''
               OR deposit_overridden_by IS NULL
               OR deposit_overridden_at IS NULL
             )
         )
    INTO n_leases, n_over, n_bad
    FROM leases;
  RAISE NOTICE 'deposit cap check: % leases, % over 2 months, % would violate', n_leases, n_over, n_bad;
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'refusing leases_deposit_over_cap_requires_override: % existing rows would violate', n_bad;
  END IF;
END $$;

ALTER TABLE leases
  ADD CONSTRAINT leases_deposit_over_cap_requires_override CHECK (
    deposit_months IS NULL
    OR deposit_months <= 2
    OR (
      deposit_override_reason IS NOT NULL
      AND btrim(deposit_override_reason) <> ''
      AND deposit_overridden_by IS NOT NULL
      AND deposit_overridden_at IS NOT NULL
    )
  );

-- Keep the trigger aligned: a reason counts only when by and at are both set.
-- Months computed from the amounts (deposit_months NULL) still raise here,
-- because the CHECK above treats NULL months as out of scope.
CREATE OR REPLACE FUNCTION fn_lease_deposit_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p properties;
  r jurisdiction_rules;
  months numeric;
  maxm numeric;
  outcome rule_check_outcome;
  reason text;
  reason_ok boolean;
BEGIN
  SELECT * INTO p FROM properties WHERE id = NEW.property_id;
  r := effective_rule(p.jurisdiction_id, NEW.org_id, 'deposit.max_months', NEW.start_date);
  maxm := CASE WHEN r.id IS NULL THEN NULL ELSE (r.value->>'max_months')::numeric END;
  months := coalesce(
    NEW.deposit_months,
    CASE WHEN NEW.rent_amount_minor > 0 THEN NEW.deposit_amount_minor::numeric / NEW.rent_amount_minor END,
    0
  );
  reason := btrim(coalesce(NEW.deposit_override_reason, ''));
  reason_ok := reason <> ''
    AND NEW.deposit_overridden_by IS NOT NULL
    AND NEW.deposit_overridden_at IS NOT NULL;
  IF reason_ok AND auth.uid() IS NOT NULL THEN
    IF NEW.deposit_overridden_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'deposit_overridden_by must be the current user' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app.has_role(NEW.org_id, '{admin,manager}') THEN
      RAISE EXCEPTION 'only an admin or manager can override the deposit cap' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  outcome := 'pass';
  IF r.id IS NOT NULL AND maxm IS NOT NULL AND months > maxm THEN
    IF r.enforcement = 'hard_block' THEN
      outcome := 'block';
    ELSIF r.enforcement = 'override_required' THEN
      outcome := CASE WHEN reason_ok THEN 'overridden'::rule_check_outcome ELSE 'block'::rule_check_outcome END;
    ELSIF r.enforcement = 'warn' THEN
      outcome := 'warn';
    END IF;
  END IF;

  -- Product cap. A typed reason with by and at is an override, not a warning.
  IF months > 2 AND outcome IS DISTINCT FROM 'block' THEN
    outcome := CASE WHEN reason_ok THEN 'overridden'::rule_check_outcome ELSE 'block'::rule_check_outcome END;
  END IF;

  IF outcome = 'block' AND NEW.status IN ('draft', 'pending_signature', 'active') THEN
    RAISE EXCEPTION 'deposit of % months exceeds cap of % months', round(months, 2), coalesce(maxm, 2)
      USING ERRCODE = 'check_violation';
  END IF;

  IF r.id IS NOT NULL THEN
    INSERT INTO rule_check_results (
      org_id, rule_id, entity_table, entity_id, outcome, observed, limit_value, message_key, overridden_by, override_reason
    ) VALUES (
      NEW.org_id, r.id, 'leases', NEW.id, outcome,
      jsonb_build_object('deposit_months', round(months, 2), 'deposit_amount_minor', NEW.deposit_amount_minor),
      coalesce(r.value, jsonb_build_object('max_months', 2)),
      'rules.deposit.max_months',
      CASE WHEN outcome = 'overridden' THEN NEW.deposit_overridden_by END,
      CASE WHEN outcome = 'overridden' THEN reason END
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_lease_deposit_check ON leases;
CREATE TRIGGER trg_lease_deposit_check
  AFTER INSERT OR UPDATE OF deposit_amount_minor, deposit_months, rent_amount_minor, status,
                         deposit_override_reason, deposit_overridden_by, deposit_overridden_at
  ON leases
  FOR EACH ROW EXECUTE FUNCTION fn_lease_deposit_check();
