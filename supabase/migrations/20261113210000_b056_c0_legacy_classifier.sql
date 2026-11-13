-- FILE: supabase/migrations/20261113210000_b056_c0_legacy_classifier.sql
-- B-056 C-0: one-time legacy classification of an org before pricing_trial is first turned ON
-- for it (design note condola-hub 20-build/specs/B-056-design.md, decision 7 and "Flag plan"
-- step 2; OQ-B056-07 accepted by Ron 2026-11-13 01:30 PT; split from PR-2 as OQ-B056-26).
-- Story: MGT-96-AC4 (a legacy trial counts as the org's one trial).
--
-- Additive only: one SECURITY DEFINER function, EXECUTE to service_role only. No table, column,
-- enum, grant or flag change; no outbound; no deletes. It never reads or writes anything while
-- it is not called; ops call it per org from the reviewed runbook (ops/runbooks/b056-c0.md).
--
-- Rule (legacy facts are not proof of payment; only a B-056 paid record makes an org paid):
--   * an org that already has a B-056 trial or paid record, or was already classified, is left
--     unchanged and its stored class is returned (idempotent; never overwrites a real trial);
--   * legacy settings.plan.trialUntil in the future → 'active_legacy_trial': the legacy trial
--     becomes the org's one trial and ends at 00:00 Asia/Taipei on the day after trialUntil's
--     Taipei date (never shortens it; OQ-B056-27);
--   * any other legacy trace — a trialUntil that is in the past, not a string, not an absolute
--     ISO-8601 timestamp with an offset/Z, or not finite; a settings.plan.tier of standard/pro/
--     business; or an upgrade_requests row → 'trial_used_not_paid': trial used, already ended
--     (at trialUntil when readable, else now), so the org is Free-after-trial once the flag is ON;
--   * otherwise → 'never_trialled' (row with no trial; the admin may start one trial later).
-- The legacy trial plan is 'pro' when the legacy tier is pro or business, else 'standard'.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION app.b056_classify_legacy(p_org uuid, p_actor uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_settings jsonb;
  v_row app.b056_org_trials%ROWTYPE;
  v_tier text;
  v_until timestamptz;
  v_until_raw text;
  v_has_until boolean;
  v_requested boolean;
  v_now timestamptz := clock_timestamp();
  v_class text;
  v_plan text;
  v_ends timestamptz;
  v_new jsonb;
BEGIN
  SELECT o.settings INTO v_settings FROM public.organizations o WHERE o.id = p_org FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'b056_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM app.b056_org_trials t WHERE t.org_id = p_org FOR UPDATE;
  IF FOUND THEN
    -- Already started, paid or classified: never overwrite.
    RETURN coalesce(v_row.legacy_class,
                    CASE WHEN v_row.paid_plan IS NOT NULL THEN 'paid'
                         WHEN v_row.trial_plan IS NOT NULL THEN 'b056_trial'
                         ELSE 'unclassified' END);
  END IF;

  v_tier := CASE WHEN jsonb_typeof(v_settings->'plan') = 'object' AND jsonb_typeof(v_settings->'plan'->'tier') = 'string'
                 THEN v_settings->'plan'->>'tier' END;
  -- Any non-null trialUntil (string, number, object…) is evidence that a trial was used.
  v_has_until := jsonb_typeof(v_settings->'plan') = 'object'
                 AND coalesce(jsonb_typeof(v_settings->'plan'->'trialUntil'), 'null') <> 'null';
  v_until_raw := CASE WHEN v_has_until AND jsonb_typeof(v_settings->'plan'->'trialUntil') = 'string'
                      THEN v_settings->'plan'->>'trialUntil' END;
  -- Only an absolute ISO-8601 timestamp with an explicit offset or Z is read as a date, so the
  -- result never depends on the session TimeZone; special values (infinity, tomorrow, …) and
  -- anything else stay evidence of a used trial but grant no active trial.
  IF v_until_raw ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
    BEGIN
      v_until := v_until_raw::timestamptz;
      IF NOT isfinite(v_until) THEN v_until := NULL; END IF;
    EXCEPTION WHEN others THEN
      v_until := NULL;
    END;
  END IF;
  v_requested := EXISTS (SELECT 1 FROM public.upgrade_requests u WHERE u.org_id = p_org);
  v_plan := CASE WHEN v_tier IN ('pro', 'business') THEN 'pro' ELSE 'standard' END;

  IF v_until IS NOT NULL AND v_until > v_now THEN
    v_class := 'active_legacy_trial';
    -- 00:00 Asia/Taipei of the day after trialUntil's Taipei date (never shorter than legacy)
    v_ends := (((v_until AT TIME ZONE 'Asia/Taipei')::date + 1)::timestamp) AT TIME ZONE 'Asia/Taipei';
  ELSIF v_has_until OR v_tier IN ('standard', 'pro', 'business') OR v_requested THEN
    v_class := 'trial_used_not_paid';
    v_ends := least(coalesce(v_until, v_now), v_now);
  ELSE
    v_class := 'never_trialled';
  END IF;

  IF v_class = 'never_trialled' THEN
    INSERT INTO app.b056_org_trials AS t (org_id, legacy_class, created_at, updated_at)
    VALUES (p_org, v_class, v_now, v_now)
    RETURNING to_jsonb(t.*) INTO v_new;
  ELSE
    INSERT INTO app.b056_org_trials AS t (org_id, trial_plan, trial_source, trial_started_at, trial_ends_at, legacy_class, created_at, updated_at)
    VALUES (p_org, v_plan, 'legacy', NULL, v_ends, v_class, v_now, v_now)
    RETURNING to_jsonb(t.*) INTO v_new;
  END IF;

  INSERT INTO public.audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, old_row, new_row, changed_cols, reason, request_id)
  VALUES (p_org, p_actor, 'ops', 'b056_org_trials', p_org::text, 'insert'::public.audit_action, NULL, v_new,
          ARRAY['legacy_class', 'trial_plan', 'trial_source', 'trial_ends_at'],
          coalesce(nullif(current_setting('app.change_reason', true), ''), 'b056 C-0 legacy classification'),
          nullif(current_setting('app.request_id', true), ''));
  RETURN v_class;
END;
$$;
REVOKE ALL ON FUNCTION app.b056_classify_legacy(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b056_classify_legacy(uuid, uuid) TO service_role;

COMMIT;
