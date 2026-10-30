BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Missing/malformed global setting or organization flag stays OFF. This is the
-- only B-007 rollout authority. Existing overrides and original rows remain.
INSERT INTO public.platform_settings(key, value, description)
VALUES ('deposit_rule_hints', '{"enabled":false,"allowed_org_ids":[]}'::jsonb,
        'Regional deposit rules are enabled only for explicitly allowed organizations.')
ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION public.resolve_deposit_rule(p_org uuid, p_property uuid, p_on date)
RETURNS TABLE (regional_enabled boolean, rule_id uuid, max_months numeric, enforcement text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  v_jurisdiction uuid;
  v_flags jsonb;
  v_global jsonb;
  v_rule public.jurisdiction_rules;
BEGIN
  SELECT p.jurisdiction_id, o.feature_flags INTO v_jurisdiction, v_flags
    FROM public.properties p JOIN public.organizations o ON o.id = p.org_id
   WHERE p.id = p_property AND p.org_id = p_org;
  IF NOT FOUND OR p_on IS NULL THEN RETURN; END IF;
  SELECT s.value INTO v_global FROM public.platform_settings s WHERE s.key = 'deposit_rule_hints';
  regional_enabled := coalesce(v_global -> 'enabled' = 'true'::jsonb, false)
    AND jsonb_typeof(v_global -> 'allowed_org_ids') = 'array'
    AND (v_global -> 'allowed_org_ids') @> jsonb_build_array(p_org::text)
    AND coalesce(v_flags -> 'deposit_rule_hints' = 'true'::jsonb, false);
  regional_enabled := coalesce(regional_enabled, false);
  v_rule := public.effective_rule(v_jurisdiction, p_org, 'deposit.max_months', p_on);
  rule_id := v_rule.id;
  enforcement := v_rule.enforcement::text;
  IF v_rule.id IS NOT NULL THEN
    IF jsonb_typeof(v_rule.value) IS DISTINCT FROM 'object' OR NOT (v_rule.value ? 'max_months') THEN
      RAISE EXCEPTION 'Invalid deposit rule' USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(v_rule.value -> 'max_months') = 'null' THEN
      max_months := NULL;
    ELSIF jsonb_typeof(v_rule.value -> 'max_months') IN ('number', 'string')
      AND btrim(v_rule.value ->> 'max_months') ~ '^[+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$' THEN
      BEGIN
        max_months := btrim(v_rule.value ->> 'max_months')::numeric;
      EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
        RAISE EXCEPTION 'Invalid deposit rule' USING ERRCODE = 'check_violation';
      END;
      IF max_months > 1e308::numeric THEN
        RAISE EXCEPTION 'Invalid deposit rule' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'Invalid deposit rule' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.resolve_deposit_rule(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_deposit_rule(uuid, uuid, date) TO authenticated, service_role;

-- A setting may be absent while OFF, so a row lock alone cannot serialize
-- insertion. The setting writer takes this key exclusively; the lease writer
-- takes it shared after nonblocking row locks. No application caller can use
-- these helpers to lock another organization's rows.
CREATE FUNCTION app.b007_deposit_setting_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('b007:deposit_rule_hints', 0));
    RETURN NULL;
  END IF;
  IF (TG_OP <> 'INSERT' AND OLD.key = 'deposit_rule_hints') OR
     (TG_OP <> 'DELETE' AND NEW.key = 'deposit_rule_hints') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('b007:deposit_rule_hints', 0));
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b007_deposit_setting_lock() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER b007_deposit_setting_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION app.b007_deposit_setting_lock();
CREATE TRIGGER b007_deposit_setting_truncate_lock
  BEFORE TRUNCATE ON public.platform_settings
  FOR EACH STATEMENT EXECUTE FUNCTION app.b007_deposit_setting_lock();

CREATE FUNCTION app.b007_lock_deposit_policy(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_caller text := coalesce(nullif(current_setting('role', true), 'none'), session_user::text);
  v_owner text := pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.leases'::regclass));
BEGIN
  -- svc()/svcOn() SET LOCAL ROLE service_role; the actual table owner is also
  -- inherently privileged. Caller-editable JWT role claims do not grant this.
  IF v_caller NOT IN ('service_role', v_owner)
     AND (auth.uid() IS NULL OR NOT app.has_role(p_org, '{admin,manager}')) THEN
    RAISE EXCEPTION 'Deposit rule access denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- NOWAIT avoids inversion with other lease/org operations; caller must retry.
  PERFORM 1 FROM public.platform_settings WHERE key='deposit_rule_hints' FOR SHARE NOWAIT;
  PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deposit rule context unavailable' USING ERRCODE = 'check_violation'; END IF;
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('b007:deposit_rule_hints', 0)) THEN
    RAISE EXCEPTION 'Deposit rule is changing; retry' USING ERRCODE = 'lock_not_available';
  END IF;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'Deposit rule is changing; retry' USING ERRCODE = 'lock_not_available';
END $$;
REVOKE ALL ON FUNCTION app.b007_lock_deposit_policy(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.b007_lock_deposit_policy(uuid) TO authenticated, service_role;

-- Ron approved replacement of this one named constraint for local/staging.
ALTER TABLE public.leases DROP CONSTRAINT leases_deposit_over_cap_requires_override;

-- The database, not a submitted timestamp, records a new override time.
-- Existing untouched metadata remains exactly as stored.
CREATE FUNCTION public.fn_b007_override_timestamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_changed boolean := true;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_changed := NEW.deposit_override_reason IS DISTINCT FROM OLD.deposit_override_reason
      OR NEW.deposit_overridden_by IS DISTINCT FROM OLD.deposit_overridden_by
      OR NEW.deposit_overridden_at IS DISTINCT FROM OLD.deposit_overridden_at;
  END IF;
  IF v_changed AND btrim(coalesce(NEW.deposit_override_reason, '')) <> ''
     AND NEW.deposit_overridden_by IS NOT NULL AND NEW.deposit_overridden_at IS NOT NULL THEN
    NEW.deposit_overridden_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_b007_override_timestamp() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_b007_override_timestamp() TO service_role;
CREATE TRIGGER trg_b007_override_timestamp
  BEFORE INSERT OR UPDATE OF deposit_override_reason, deposit_overridden_by, deposit_overridden_at
  ON public.leases FOR EACH ROW EXECUTE FUNCTION public.fn_b007_override_timestamp();

CREATE OR REPLACE FUNCTION public.fn_lease_deposit_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_rule record;
  v_months numeric;
  v_monthly numeric;
  v_expected numeric;
  v_cap numeric;
  v_outcome public.rule_check_outcome := 'pass';
  v_reason text := btrim(coalesce(NEW.deposit_override_reason, ''));
  v_reason_ok boolean := v_reason <> '' AND NEW.deposit_overridden_by IS NOT NULL AND NEW.deposit_overridden_at IS NOT NULL;
  v_changed boolean := true;
  v_terms_changed boolean := true;
BEGIN
  PERFORM app.b007_lock_deposit_policy(NEW.org_id);
  -- This separate statement resolves the current committed policy after locks.
  SELECT * INTO v_rule FROM public.resolve_deposit_rule(NEW.org_id, NEW.property_id, NEW.start_date);
  IF NOT FOUND THEN RAISE EXCEPTION 'Deposit rule context unavailable' USING ERRCODE = 'check_violation'; END IF;
  v_monthly := NEW.rent_amount_minor::numeric / CASE NEW.rent_frequency::text WHEN 'quarterly' THEN 3 WHEN 'yearly' THEN 12 ELSE 1 END;
  IF v_monthly = 0 AND NEW.deposit_amount_minor > 0 THEN
    RAISE EXCEPTION 'Deposit requires a nonzero rent basis' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.deposit_months IS NOT NULL AND v_monthly > 0 THEN
    v_expected := CASE WHEN NEW.currency = 'TWD'
      THEN round(v_monthly * NEW.deposit_months / 100) * 100
      ELSE round(v_monthly * NEW.deposit_months) END;
    IF NEW.deposit_amount_minor IS DISTINCT FROM v_expected::bigint THEN
      RAISE EXCEPTION 'Deposit amount and months do not match' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  v_months := coalesce(NEW.deposit_months,
    CASE WHEN v_monthly > 0 THEN NEW.deposit_amount_minor::numeric / v_monthly END, 0);
  IF TG_OP = 'UPDATE' THEN
    v_changed := NEW.deposit_override_reason IS DISTINCT FROM OLD.deposit_override_reason
      OR NEW.deposit_overridden_by IS DISTINCT FROM OLD.deposit_overridden_by
      OR NEW.deposit_overridden_at IS DISTINCT FROM OLD.deposit_overridden_at;
    v_terms_changed := NEW.deposit_amount_minor IS DISTINCT FROM OLD.deposit_amount_minor
      OR NEW.deposit_months IS DISTINCT FROM OLD.deposit_months
      OR NEW.rent_amount_minor IS DISTINCT FROM OLD.rent_amount_minor
      OR NEW.rent_frequency IS DISTINCT FROM OLD.rent_frequency
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.property_id IS DISTINCT FROM OLD.property_id
      OR NEW.org_id IS DISTINCT FROM OLD.org_id
      OR NEW.start_date IS DISTINCT FROM OLD.start_date;
  END IF;
  IF v_changed AND v_reason_ok THEN
    IF (auth.uid() IS NULL AND current_user = 'authenticated') OR
       (auth.uid() IS NOT NULL AND (NEW.deposit_overridden_by IS DISTINCT FROM auth.uid() OR NOT app.has_role(NEW.org_id, '{admin,manager}'))) THEN
      RAISE EXCEPTION 'Deposit override requires the current authorized actor' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  v_cap := v_rule.max_months;
  IF v_cap IS NOT NULL AND v_months > v_cap THEN
    IF v_rule.enforcement = 'hard_block' THEN v_outcome := 'block';
    ELSIF v_rule.enforcement = 'override_required' THEN
      v_outcome := CASE WHEN v_reason_ok THEN 'overridden'::public.rule_check_outcome ELSE 'block'::public.rule_check_outcome END;
    ELSIF v_rule.enforcement = 'warn' THEN v_outcome := 'warn';
    END IF;
  END IF;
  -- Preserve the old global two-month requirement while rollout is OFF.
  IF NOT v_rule.regional_enabled AND v_months > 2 THEN
    IF NOT v_reason_ok THEN RAISE EXCEPTION 'deposit of % months exceeds cap of % months', round(v_months, 2), coalesce(v_cap, 2) USING ERRCODE = 'check_violation'; END IF;
    IF v_outcome <> 'block' THEN v_outcome := 'overridden'; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.deposit_override_reason IS NOT NULL AND OLD.deposit_overridden_by IS NOT NULL
     AND OLD.deposit_overridden_at IS NOT NULL AND v_changed AND
     (NOT v_terms_changed OR v_outcome <> 'overridden') THEN
    RAISE EXCEPTION 'Existing deposit override history must be retained' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND v_terms_changed AND v_reason_ok AND
     (v_outcome = 'overridden' OR (NOT v_rule.regional_enabled AND v_months > 2)) AND
     NEW.deposit_overridden_at IS NOT DISTINCT FROM OLD.deposit_overridden_at THEN
    RAISE EXCEPTION 'Changed over-cap terms require a new override' USING ERRCODE = 'check_violation';
  END IF;
  IF v_outcome = 'block' AND NEW.status IN ('draft', 'pending_signature', 'active') THEN
    RAISE EXCEPTION 'deposit of % months exceeds cap of % months', round(v_months, 2), coalesce(v_cap, 2) USING ERRCODE = 'check_violation';
  END IF;
  IF v_rule.rule_id IS NOT NULL THEN
    INSERT INTO public.rule_check_results (org_id, rule_id, entity_table, entity_id, outcome, observed, limit_value, message_key, overridden_by, override_reason)
    VALUES (NEW.org_id, v_rule.rule_id, 'leases', NEW.id, v_outcome,
      jsonb_build_object('deposit_months', v_months, 'deposit_amount_minor', NEW.deposit_amount_minor,
        'rent_amount_minor', NEW.rent_amount_minor, 'rent_frequency', NEW.rent_frequency, 'currency', NEW.currency),
      jsonb_build_object('max_months', v_cap), 'rules.deposit.max_months',
      CASE WHEN v_outcome = 'overridden' THEN NEW.deposit_overridden_by END,
      CASE WHEN v_outcome = 'overridden' THEN v_reason END);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER trg_lease_deposit_check ON public.leases;
CREATE TRIGGER trg_lease_deposit_check
  AFTER INSERT OR UPDATE OF deposit_amount_minor, deposit_months, rent_amount_minor, rent_frequency, currency, status,
    deposit_override_reason, deposit_overridden_by, deposit_overridden_at, property_id, unit_id, target_unit_id, target_room_id, org_id, start_date
  ON public.leases FOR EACH ROW EXECUTE FUNCTION public.fn_lease_deposit_check();
COMMIT;
