BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- OFF must not evaluate (or validate) jurisdiction rules.
CREATE OR REPLACE FUNCTION public.resolve_deposit_rule(p_org uuid, p_property uuid, p_on date)
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
  regional_enabled := coalesce(
    v_global -> 'enabled' = 'true'::jsonb
    AND jsonb_typeof(v_global -> 'allowed_org_ids') = 'array'
    AND (v_global -> 'allowed_org_ids') @> jsonb_build_array(p_org::text)
    AND v_flags -> 'deposit_rule_hints' = 'true'::jsonb, false);
  IF NOT regional_enabled THEN
    RETURN NEXT;
    RETURN;
  END IF;
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

CREATE OR REPLACE FUNCTION app.b007_lock_deposit_policy(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_caller text := coalesce(nullif(current_setting('role', true), 'none'), session_user::text);
  v_owner text := pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.leases'::regclass));
  v_timeout text := current_setting('lock_timeout');
BEGIN
  IF v_caller NOT IN ('service_role', v_owner)
     AND (auth.uid() IS NULL OR NOT app.has_role(p_org, '{admin,manager}')) THEN
    RAISE EXCEPTION 'Deposit rule access denied' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  FOR v_attempt IN 1..3 LOOP
    BEGIN
      PERFORM 1 FROM public.platform_settings WHERE key='deposit_rule_hints' FOR SHARE;
      PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Deposit rule context unavailable' USING ERRCODE = 'check_violation';
      END IF;
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('b007:deposit_rule_hints', 0));
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_attempt = 3 THEN
        RAISE EXCEPTION 'Deposit rule is changing; retry' USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.05 * v_attempt);
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', v_timeout, true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('lock_timeout', v_timeout, true);
  RAISE;
END $$;

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
  IF TG_OP = 'UPDATE' THEN
    v_changed := ROW(NEW.deposit_override_reason, NEW.deposit_overridden_by, NEW.deposit_overridden_at)
      IS DISTINCT FROM ROW(OLD.deposit_override_reason, OLD.deposit_overridden_by, OLD.deposit_overridden_at);
    v_terms_changed := ROW(NEW.deposit_amount_minor, NEW.deposit_months, NEW.rent_amount_minor,
      NEW.rent_frequency, NEW.currency, NEW.property_id, NEW.unit_id, NEW.target_unit_id,
      NEW.target_room_id, NEW.org_id, NEW.start_date)
      IS DISTINCT FROM ROW(OLD.deposit_amount_minor, OLD.deposit_months, OLD.rent_amount_minor,
      OLD.rent_frequency, OLD.currency, OLD.property_id, OLD.unit_id, OLD.target_unit_id,
      OLD.target_room_id, OLD.org_id, OLD.start_date);
    -- Signing and other unrelated writes must not revalidate historical terms.
    IF NOT v_terms_changed AND NOT v_changed THEN RETURN NEW; END IF;
  END IF;

  IF v_changed AND v_reason_ok THEN
    IF (auth.uid() IS NULL AND current_user = 'authenticated') OR
       (auth.uid() IS NOT NULL AND (NEW.deposit_overridden_by IS DISTINCT FROM auth.uid()
         OR NOT app.has_role(NEW.org_id, '{admin,manager}'))) THEN
      RAISE EXCEPTION 'Deposit override requires the current authorized actor' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NOT v_terms_changed THEN
    -- Accept the legacy Worker's regenerated timestamp and complete attribution.
    -- Clearing existing history is still forbidden; no money or policy checks run.
    IF NOT v_reason_ok THEN
      RAISE EXCEPTION 'Existing deposit override history must be retained' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.rule_check_results
      (org_id, rule_id, entity_table, entity_id, outcome, observed, limit_value,
       message_key, overridden_by, override_reason, checked_at)
    SELECT NEW.org_id, c.rule_id, 'leases', NEW.id, c.outcome, c.observed,
      c.limit_value, c.message_key,
      CASE WHEN c.outcome = 'overridden' THEN NEW.deposit_overridden_by END,
      CASE WHEN c.outcome = 'overridden' THEN v_reason END, clock_timestamp()
    FROM public.rule_check_results c
    JOIN public.jurisdiction_rules r ON r.id = c.rule_id
    WHERE c.org_id = NEW.org_id AND c.entity_table = 'leases' AND c.entity_id = NEW.id
      AND r.rule_key = 'deposit.max_months'
    ORDER BY c.checked_at DESC LIMIT 1;
    RETURN NEW;
  END IF;

  PERFORM app.b007_lock_deposit_policy(NEW.org_id);
  BEGIN
    SELECT * INTO v_rule FROM public.resolve_deposit_rule(NEW.org_id, NEW.property_id, NEW.start_date);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Deposit rule context unavailable' USING ERRCODE = 'check_violation';
    END IF;
  EXCEPTION WHEN undefined_function THEN
    SELECT false AS regional_enabled, NULL::uuid AS rule_id,
      NULL::numeric AS max_months, NULL::text AS enforcement INTO v_rule;
  END;
  v_monthly := NEW.rent_amount_minor::numeric /
    CASE NEW.rent_frequency::text WHEN 'quarterly' THEN 3 WHEN 'yearly' THEN 12 ELSE 1 END;
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
  v_cap := CASE WHEN v_rule.regional_enabled THEN v_rule.max_months ELSE 2 END;
  IF v_rule.regional_enabled AND v_cap IS NOT NULL AND v_months > v_cap THEN
    IF v_rule.enforcement = 'hard_block' THEN v_outcome := 'block';
    ELSIF v_rule.enforcement = 'override_required' THEN
      v_outcome := CASE WHEN v_reason_ok THEN 'overridden'::public.rule_check_outcome ELSE 'block'::public.rule_check_outcome END;
    ELSIF v_rule.enforcement = 'warn' THEN v_outcome := 'warn';
    END IF;
  END IF;
  IF NOT v_rule.regional_enabled AND v_months > 2 THEN
    IF NOT v_reason_ok THEN
      RAISE EXCEPTION 'deposit of % months exceeds cap of 2 months', round(v_months, 2) USING ERRCODE = 'check_violation';
    END IF;
    v_outcome := 'overridden';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.deposit_override_reason IS NOT NULL AND OLD.deposit_overridden_by IS NOT NULL
       AND OLD.deposit_overridden_at IS NOT NULL AND v_changed AND v_outcome <> 'overridden' THEN
      RAISE EXCEPTION 'Existing deposit override history must be retained' USING ERRCODE = 'check_violation';
    END IF;
    IF v_reason_ok AND v_outcome = 'overridden'
       AND NEW.deposit_overridden_at IS NOT DISTINCT FROM OLD.deposit_overridden_at THEN
      RAISE EXCEPTION 'Changed over-cap terms require a new override' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF v_outcome = 'block' AND NEW.status IN ('draft', 'pending_signature', 'active') THEN
    RAISE EXCEPTION 'deposit of % months exceeds cap of % months', round(v_months, 2), v_cap USING ERRCODE = 'check_violation';
  END IF;
  -- Legacy overrides still record the effective rule, without evaluating its
  -- regional cap, enforcement or payload while rollout is OFF.
  IF NOT v_rule.regional_enabled AND v_outcome = 'overridden' THEN
    SELECT (public.effective_rule(p.jurisdiction_id, NEW.org_id,
      'deposit.max_months', NEW.start_date)).id
      INTO v_rule.rule_id
      FROM public.properties p
     WHERE p.id = NEW.property_id AND p.org_id = NEW.org_id;
  END IF;
  IF v_rule.rule_id IS NOT NULL THEN
    INSERT INTO public.rule_check_results
      (org_id, rule_id, entity_table, entity_id, outcome, observed, limit_value,
       message_key, overridden_by, override_reason, checked_at)
    VALUES (NEW.org_id, v_rule.rule_id, 'leases', NEW.id, v_outcome,
      jsonb_build_object('deposit_months', v_months, 'deposit_amount_minor', NEW.deposit_amount_minor,
        'rent_amount_minor', NEW.rent_amount_minor, 'rent_frequency', NEW.rent_frequency, 'currency', NEW.currency),
      jsonb_build_object('max_months', v_cap), 'rules.deposit.max_months',
      CASE WHEN v_outcome = 'overridden' THEN NEW.deposit_overridden_by END,
      CASE WHEN v_outcome = 'overridden' THEN v_reason END, clock_timestamp());
  END IF;
  RETURN NEW;
END $$;
COMMIT;
