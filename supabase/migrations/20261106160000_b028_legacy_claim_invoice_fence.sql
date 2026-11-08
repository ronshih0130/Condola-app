-- B-028 / BLK-MAC-11: close the uncommitted legacy-claim OFF->ON race.
-- Replaces only app.b010_fence_legacy_reminders (body of
-- 20261104120300_b010_flag_first_locks.sql plus one leading invoice
-- FOR KEY SHARE NOWAIT lock with bounded polling). No table, column, grant, flag or data change; flags stay
-- OFF; old Worker compatible. CREATE OR REPLACE preserves owner, privileges and
-- the existing BEFORE INSERT OR UPDATE OR DELETE trigger on public.email_log.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION app.b010_fence_legacy_reminders() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  v_enabled boolean;
  v_attempt integer;
  v_deadline timestamptz;
  v_remaining double precision;
BEGIN
  IF TG_OP='UPDATE' AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
    AND NEW.kind IS NOT DISTINCT FROM OLD.kind AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
    AND NEW.threshold IS NOT DISTINCT FROM OLD.threshold THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' AND NEW.kind NOT IN ('rent_overdue_admin','rent_overdue_tenant') THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' AND OLD.kind NOT IN ('rent_overdue_admin','rent_overdue_tenant') THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND NEW.kind NOT IN ('rent_overdue_admin','rent_overdue_tenant')
    AND OLD.kind NOT IN ('rent_overdue_admin','rent_overdue_tenant') THEN RETURN NEW; END IF;

  -- BLK-MAC-11: serialize every legacy rent-overdue claim with the new-owner
  -- paths for the same invoice, whatever the rollout state. All five new-path
  -- functions (b010_schedule_rent, b010_manual_reminder, b028_claim_manual,
  -- b028_finish_manual, b028_claim_scheduled) take the invoice FOR UPDATE before
  -- their email_log check. FOR KEY SHARE conflicts only with FOR UPDATE (and key
  -- updates), so an in-flight uncommitted legacy claim makes the new path wait
  -- and then see the committed claim. Per the B-010 r3 lock design the legacy
  -- side itself never waits: NOWAIT with bounded polling (about six seconds),
  -- then 55P03 'Legacy reminder claim busy', which legacyReminderStore treats as
  -- fenced (no send). With no waiting edge from this trigger it cannot close a
  -- deadlock cycle, even in a multi-claim legacy transaction that already holds
  -- other invoice locks. A lock only: no row is written while the rollout is OFF.
  v_deadline:=clock_timestamp()+interval '6 seconds';
  LOOP
    BEGIN
      -- The implicit table lock of FOR KEY SHARE could otherwise wait on DDL.
      LOCK TABLE public.invoices IN ROW SHARE MODE NOWAIT;
      PERFORM 1 FROM public.invoices i
        WHERE (TG_OP <> 'INSERT' AND OLD.kind IN ('rent_overdue_admin','rent_overdue_tenant')
               AND i.id=OLD.target_id AND i.org_id=OLD.org_id)
           OR (TG_OP <> 'DELETE' AND NEW.kind IN ('rent_overdue_admin','rent_overdue_tenant')
               AND i.id=NEW.target_id AND i.org_id=NEW.org_id)
        ORDER BY i.id FOR KEY SHARE OF i NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      v_remaining:=extract(epoch FROM v_deadline-clock_timestamp());
      IF v_remaining<=0 THEN
        RAISE EXCEPTION 'Legacy reminder claim busy' USING ERRCODE='55P03';
      END IF;
      PERFORM pg_sleep(least(0.05,v_remaining));
    END;
  END LOOP;

  SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings p ON p.key='rent_reminders_v2'
    WHERE ((TG_OP <> 'INSERT' AND o.id=OLD.org_id AND OLD.kind IN ('rent_overdue_admin','rent_overdue_tenant'))
       OR (TG_OP <> 'DELETE' AND o.id=NEW.org_id AND NEW.kind IN ('rent_overdue_admin','rent_overdue_tenant')))
      AND o.feature_flags->'rent_reminders_v2'='true'::jsonb
      AND p.value->'enabled'='true'::jsonb AND jsonb_typeof(p.value->'allowed_org_ids')='array'
      AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
  IF NOT v_enabled THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  FOR v_attempt IN 1..3 LOOP
    BEGIN
      v_deadline:=clock_timestamp()+interval '2 seconds';
      LOOP
        BEGIN
          LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
          -- Stable ordering also covers identity updates spanning two orgs.
          PERFORM 1 FROM public.organizations
            WHERE (TG_OP <> 'INSERT' AND id=OLD.org_id)
               OR (TG_OP <> 'DELETE' AND id=NEW.org_id)
            ORDER BY id FOR SHARE NOWAIT;

          SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings p ON p.key='rent_reminders_v2'
            WHERE ((TG_OP <> 'INSERT' AND o.id=OLD.org_id AND OLD.kind IN ('rent_overdue_admin','rent_overdue_tenant'))
               OR (TG_OP <> 'DELETE' AND o.id=NEW.org_id AND NEW.kind IN ('rent_overdue_admin','rent_overdue_tenant')))
              AND o.feature_flags->'rent_reminders_v2'='true'::jsonb
              AND p.value->'enabled'='true'::jsonb AND jsonb_typeof(p.value->'allowed_org_ids')='array'
              AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
          EXIT;
        EXCEPTION WHEN lock_not_available THEN
          v_remaining:=extract(epoch FROM v_deadline-clock_timestamp());
          IF v_remaining<=0 THEN RAISE; END IF;
          PERFORM pg_sleep(least(0.05,v_remaining));
        END;
      END LOOP;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_attempt=3 THEN
        RAISE EXCEPTION 'Legacy reminder claim busy' USING ERRCODE='55P03';
      END IF;
      PERFORM pg_sleep(0.05*v_attempt);
    END;
  END LOOP;

  IF v_enabled THEN
    RAISE EXCEPTION 'Legacy reminder claim unavailable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

COMMIT;
