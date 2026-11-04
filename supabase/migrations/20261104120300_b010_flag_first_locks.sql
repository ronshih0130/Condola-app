BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CREATE OR REPLACE preserves the existing owners and execution privileges.
CREATE OR REPLACE FUNCTION app.b010_guard_payment_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE
  v_kind text;
  v_enabled boolean;
  v_actor uuid:=auth.uid();
  v_timeout text;
  v_attempt integer;
BEGIN
  IF TG_OP='INSERT' AND NEW.status='submitted' THEN RETURN NEW;
  ELSIF TG_OP='UPDATE' AND OLD.status=NEW.status THEN RETURN NEW;
  ELSIF TG_OP='INSERT' AND NEW.status='confirmed' THEN v_kind:='payment_confirmed';
  ELSIF TG_OP='UPDATE' AND OLD.status='submitted' AND NEW.status='confirmed' THEN v_kind:='payment_confirmed';
  ELSIF TG_OP='UPDATE' AND OLD.status='submitted' AND NEW.status='rejected' THEN v_kind:='payment_rejected';
  ELSIF TG_OP='UPDATE' AND OLD.status='confirmed' AND NEW.status='reversed' THEN v_kind:='payment_reversed';
  ELSE v_kind:='unsupported'; END IF;

  SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='payment_results_v2'
    WHERE o.id=NEW.org_id AND o.feature_flags->'payment_results_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
  IF NOT v_enabled THEN RETURN NEW; END IF;

  v_timeout:=current_setting('lock_timeout');
  BEGIN
    FOR v_attempt IN 1..3 LOOP
      BEGIN
        PERFORM set_config('lock_timeout','2s',true);
        LOCK TABLE public.platform_settings IN SHARE MODE;
        PERFORM 1 FROM public.organizations WHERE id=NEW.org_id FOR SHARE;
        SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='payment_results_v2'
          WHERE o.id=NEW.org_id AND o.feature_flags->'payment_results_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
            AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
        IF v_enabled THEN
          IF v_kind='unsupported' THEN RAISE EXCEPTION 'Payment transition unavailable' USING ERRCODE='23514'; END IF;
          PERFORM 1 FROM public.leases WHERE id=NEW.lease_id AND org_id=NEW.org_id FOR SHARE;
          IF NOT FOUND OR v_actor IS NULL THEN RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501'; END IF;
        END IF;
        EXIT;
      EXCEPTION WHEN lock_not_available THEN
        IF v_attempt=3 THEN RAISE EXCEPTION 'Payment result busy' USING ERRCODE='55P03'; END IF;
        PERFORM pg_sleep(0.05*v_attempt);
      END;
    END LOOP;
    PERFORM set_config('lock_timeout',v_timeout,true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('lock_timeout',v_timeout,true);
    RAISE;
  END;
  IF NOT v_enabled THEN RETURN NEW; END IF;
  INSERT INTO app.b010_payment_requirements(tx_id,org_id,lease_id,payment_id,kind,actor_id)
    VALUES(txid_current(),NEW.org_id,NEW.lease_id,NEW.id,v_kind,v_actor);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.b010_lock_payment_context(p_org uuid,p_live_org uuid,p_environment text,p_session uuid,p_lease uuid,p_role text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  v_actor uuid:=auth.uid();
  v_enabled boolean;
  v_timeout text;
  v_attempt integer;
BEGIN
  -- Scope authorization applies even when the rollout is OFF. It takes no
  -- explicit locks and must not become a permissive legacy fallback.
  -- Validate membership and scope before granting a caller any privileged locks.
  IF NOT EXISTS (SELECT 1 FROM public.organizations o JOIN public.org_members m
      ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
    WHERE o.id=p_org AND o.environment::text=p_environment
      AND ((o.environment='live' AND o.id=p_live_org AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live_org))
      AND m.user_id=v_actor AND m.status='active' AND m.role::text=p_role AND m.role IN ('admin','manager','accountant')) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='payment_results_v2'
    WHERE o.id=p_org AND o.feature_flags->'payment_results_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
  IF NOT v_enabled THEN RETURN false; END IF;

  v_timeout:=current_setting('lock_timeout');
  BEGIN
    FOR v_attempt IN 1..3 LOOP
      BEGIN
        PERFORM set_config('lock_timeout','2s',true);
        LOCK TABLE public.platform_settings IN SHARE MODE;
        PERFORM 1 FROM public.organizations o WHERE o.id=p_org FOR SHARE;
        SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='payment_results_v2'
          WHERE o.id=p_org AND o.feature_flags->'payment_results_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
            AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
        IF v_enabled THEN
          PERFORM 1 FROM public.organizations o JOIN public.org_members m ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
            JOIN public.auth_sessions s ON s.id=p_session AND s.user_id=v_actor
            WHERE o.id=p_org AND o.environment::text=p_environment
              AND ((o.environment='live' AND o.id=p_live_org AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live_org))
              AND m.user_id=v_actor AND m.status='active' AND m.role::text=p_role AND m.role IN ('admin','manager','accountant')
              AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF m,s;
          IF NOT FOUND THEN RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501'; END IF;
          PERFORM 1 FROM public.leases WHERE id=p_lease AND org_id=p_org FOR SHARE;
          IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=v_actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN
            RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
          END IF;
        END IF;
        EXIT;
      EXCEPTION WHEN lock_not_available THEN
        IF v_attempt=3 THEN RAISE EXCEPTION 'Payment result busy' USING ERRCODE='55P03'; END IF;
        PERFORM pg_sleep(0.05*v_attempt);
      END;
    END LOOP;
    PERFORM set_config('lock_timeout',v_timeout,true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('lock_timeout',v_timeout,true);
    RAISE;
  END;
  IF NOT v_enabled THEN RETURN false; END IF;
  INSERT INTO app.b010_payment_contexts(tx_id,org_id,lease_id,actor_id,session_id,role)
    VALUES(txid_current(),p_org,p_lease,v_actor,p_session,p_role)
    ON CONFLICT(tx_id,org_id,lease_id,actor_id) DO UPDATE SET session_id=EXCLUDED.session_id,role=EXCLUDED.role;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app.b010_fence_legacy_reminders() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  v_enabled boolean;
  v_timeout text;
  v_attempt integer;
BEGIN
  IF TG_OP='UPDATE' AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
    AND NEW.kind IS NOT DISTINCT FROM OLD.kind AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
    AND NEW.threshold IS NOT DISTINCT FROM OLD.threshold THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' AND NEW.kind NOT IN ('rent_overdue_admin','rent_overdue_tenant') THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' AND OLD.kind NOT IN ('rent_overdue_admin','rent_overdue_tenant') THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND NEW.kind NOT IN ('rent_overdue_admin','rent_overdue_tenant')
    AND OLD.kind NOT IN ('rent_overdue_admin','rent_overdue_tenant') THEN RETURN NEW; END IF;

  SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings p ON p.key='rent_reminders_v2'
    WHERE ((TG_OP <> 'INSERT' AND o.id=OLD.org_id AND OLD.kind IN ('rent_overdue_admin','rent_overdue_tenant'))
       OR (TG_OP <> 'DELETE' AND o.id=NEW.org_id AND NEW.kind IN ('rent_overdue_admin','rent_overdue_tenant')))
      AND o.feature_flags->'rent_reminders_v2'='true'::jsonb
      AND p.value->'enabled'='true'::jsonb AND jsonb_typeof(p.value->'allowed_org_ids')='array'
      AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
  IF NOT v_enabled THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  v_timeout:=current_setting('lock_timeout');
  BEGIN
    FOR v_attempt IN 1..3 LOOP
      BEGIN
        PERFORM set_config('lock_timeout','2s',true);
        LOCK TABLE public.platform_settings IN SHARE MODE;
        -- Stable ordering also covers identity updates spanning two orgs.
        PERFORM 1 FROM public.organizations
          WHERE (TG_OP <> 'INSERT' AND id=OLD.org_id)
             OR (TG_OP <> 'DELETE' AND id=NEW.org_id)
          ORDER BY id FOR SHARE;
        SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings p ON p.key='rent_reminders_v2'
          WHERE ((TG_OP <> 'INSERT' AND o.id=OLD.org_id AND OLD.kind IN ('rent_overdue_admin','rent_overdue_tenant'))
             OR (TG_OP <> 'DELETE' AND o.id=NEW.org_id AND NEW.kind IN ('rent_overdue_admin','rent_overdue_tenant')))
            AND o.feature_flags->'rent_reminders_v2'='true'::jsonb
            AND p.value->'enabled'='true'::jsonb AND jsonb_typeof(p.value->'allowed_org_ids')='array'
            AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
        EXIT;
      EXCEPTION WHEN lock_not_available THEN
        IF v_attempt=3 THEN RAISE EXCEPTION 'Legacy reminder claim busy' USING ERRCODE='55P03'; END IF;
        PERFORM pg_sleep(0.05*v_attempt);
      END;
    END LOOP;
    PERFORM set_config('lock_timeout',v_timeout,true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('lock_timeout',v_timeout,true);
    RAISE;
  END;
  IF v_enabled THEN RAISE EXCEPTION 'Legacy reminder claim unavailable' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

COMMIT;
