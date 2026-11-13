-- FILE: supabase/migrations/20261113200000_b056_trial_engine_schema.sql
-- B-056 PR-1 (trial engine foundation). Stories: MGT-96-AC2, MGT-96-AC4, MGT-97-AC1, MGT-98-AC2.
-- Design note: condola-hub 20-build/specs/B-056-design.md (r2), PR plan row PR-1.
--
-- Additive only. Flag pricing_trial seeded OFF (enabled false, empty allowlist). Nothing in the
-- app reads these objects yet; with the flag OFF every function refuses (fail closed).
-- No change to plan_tier, organizations columns, member_status, pricing_apply_requests, B-030,
-- FREE_UNITS or any existing table. No outbound (no NOTIFY, no mail or LINE hooks). No deletes.
--
-- Narrowed scope (OQ-B056-23): the read-only snapshot (b056_editable_spaces), member pause
-- (b056_paused_members, member_status 'paused'), markers, trigger, expiry job, legacy classifier,
-- paid activation and the business calendar ship with the PRs that use them (PR-2…PR-5), because
-- open design findings #3/#4/#5 (receipts/b056/codex-review-design-r2.md) concern exactly those
-- objects.
--
-- ADR-112 access path for every table below: definer-only. ENABLE + FORCE RLS, no policies,
-- REVOKE ALL from PUBLIC/anon/authenticated, no table grant to any API role. Rows are reached only
-- through the SECURITY DEFINER functions below; EXECUTE is granted to service_role only, and the
-- server authorizes before calling them via svc().

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Flag: effective only when platform_settings.pricing_trial.enabled is boolean true AND
-- allowed_org_ids is an all-string array containing the org (a mixed-type allowlist admits
-- nobody, same rule as the TS twin) AND organizations.feature_flags.pricing_trial is boolean true.
INSERT INTO public.platform_settings(key, value, description)
VALUES (
  'pricing_trial',
  '{"enabled":false,"allowed_org_ids":[]}'::jsonb,
  'B-056 in-app trial engine (Standard 3 months / Premium 6 months). Default OFF. Effective only when enabled is boolean true AND allowed_org_ids includes the org AND organizations.feature_flags.pricing_trial is boolean true. First ON = Ron''s 4 internal orgs after QA 0 blockers and CEO exact-SHA GO.'
)
ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION app.b056_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_settings f JOIN public.organizations o ON o.id = p_org
     WHERE f.key = 'pricing_trial'
       AND jsonb_typeof(f.value) = 'object'
       AND f.value->'enabled' = 'true'::jsonb
       AND jsonb_typeof(f.value->'allowed_org_ids') = 'array'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.value->'allowed_org_ids') e WHERE jsonb_typeof(e) <> 'string')
       AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
       AND jsonb_typeof(o.feature_flags) = 'object'
       AND o.feature_flags->'pricing_trial' = 'true'::jsonb)
$$;

-- One row per org. Trial used = trial_plan IS NOT NULL; never cleared (MGT-96-AC4).
-- paid_* are written only by paid activation (PR-5); legacy_class only by C-0 (PR-2).
CREATE TABLE app.b056_org_trials (
  org_id                  uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  trial_plan              text NULL CHECK (trial_plan IN ('standard', 'pro')),
  trial_source            text NULL CHECK (trial_source IN ('settings', 'legacy')),
  trial_started_at        timestamptz NULL,
  trial_ends_at           timestamptz NULL,
  started_by              uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  paid_plan               text NULL CHECK (paid_plan IN ('standard', 'pro')),
  paid_activated_at       timestamptz NULL,
  paid_apply_request_id   uuid NULL REFERENCES public.pricing_apply_requests(id) ON DELETE RESTRICT,
  paid_request_created_at timestamptz NULL,
  paid_activated_by       uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  legacy_class            text NULL CHECK (legacy_class IN ('trial_used_not_paid', 'active_legacy_trial', 'never_trialled')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- trial facts are all present or all absent
  CONSTRAINT b056_trial_facts_together CHECK (
    (trial_plan IS NULL) = (trial_source IS NULL) AND (trial_plan IS NULL) = (trial_ends_at IS NULL)),
  -- a settings trial has a start; only a legacy trial may lack one
  CONSTRAINT b056_trial_start_known CHECK (trial_source IS DISTINCT FROM 'settings' OR trial_started_at IS NOT NULL),
  CONSTRAINT b056_trial_ends_after_start CHECK (trial_started_at IS NULL OR trial_ends_at > trial_started_at),
  -- paid facts are all present or all absent
  CONSTRAINT b056_paid_facts_together CHECK (
    (paid_plan IS NULL) = (paid_activated_at IS NULL)
    AND (paid_plan IS NULL) = (paid_apply_request_id IS NULL)
    AND (paid_plan IS NULL) = (paid_request_created_at IS NULL))
);
ALTER TABLE app.b056_org_trials ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b056_org_trials FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.b056_org_trials FROM PUBLIC, anon, authenticated, service_role;

-- Banner seen/dismissed per user per threshold (MGT-98-AC2; Ron 01:34 PT: per user).
CREATE TABLE app.b056_banner_dismissals (
  org_id               uuid NOT NULL REFERENCES app.b056_org_trials(org_id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('d14', 'd3', 'd1', 'expired')),
  trial_ends_at        timestamptz NOT NULL,
  seen_or_dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, kind)
);
ALTER TABLE app.b056_banner_dismissals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b056_banner_dismissals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.b056_banner_dismissals FROM PUBLIC, anon, authenticated, service_role;

-- Facts for the server-side resolver (resolveEffectivePlan, PR-2). Statement time, not txn start.
-- Returns no row when the flag is OFF for the org; returns a row with NULL facts when the flag is
-- ON and the org has no B-056 row yet.
CREATE FUNCTION app.b056_plan_facts(p_org uuid)
RETURNS TABLE (
  as_of timestamptz, trial_plan text, trial_source text, trial_started_at timestamptz,
  trial_ends_at timestamptz, paid_plan text, paid_activated_at timestamptz, legacy_class text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT clock_timestamp(), t.trial_plan, t.trial_source, t.trial_started_at, t.trial_ends_at,
         t.paid_plan, t.paid_activated_at, t.legacy_class
    FROM (SELECT 1) one
    LEFT JOIN app.b056_org_trials t ON t.org_id = p_org
   WHERE app.b056_enabled(p_org)
$$;

-- End of a trial that starts on Asia/Taipei date d: 00:00 Asia/Taipei of d + 3 or 6 months,
-- PostgreSQL clamp at month end (11/30 + 3 months = 2/28 or 2/29). OQ-B056-06.
CREATE FUNCTION app.b056_trial_end(p_plan text, p_start timestamptz) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_start_day date := (p_start AT TIME ZONE 'Asia/Taipei')::date;
BEGIN
  IF p_plan = 'standard' THEN
    RETURN ((v_start_day + interval '3 months')::date)::timestamp AT TIME ZONE 'Asia/Taipei';
  ELSIF p_plan = 'pro' THEN
    RETURN ((v_start_day + interval '6 months')::date)::timestamp AT TIME ZONE 'Asia/Taipei';
  END IF;
  RAISE EXCEPTION 'b056_invalid_plan' USING ERRCODE = '22023';
END;
$$;

-- Start a trial (MGT-96-AC2, MGT-96-AC4, MGT-97-AC1). The caller passes the org from
-- session.liveOrgId and the acting user; this function re-checks that the actor is an active
-- admin of that org. Exactly one trial per org, ever: a second start (concurrent or later), or a
-- start by an org that is already paid, is refused and writes nothing.
-- Lock order (design note): organizations row, then the b056_org_trials row.
CREATE FUNCTION app.b056_start_trial(p_org uuid, p_actor uuid, p_plan text)
RETURNS TABLE (started boolean, refusal text, trial_ends_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_row app.b056_org_trials%ROWTYPE;
  v_existed boolean;
  v_now timestamptz;
  v_end timestamptz;
  v_new jsonb;
BEGIN
  IF p_plan IS NULL OR p_plan NOT IN ('standard', 'pro') THEN
    RAISE EXCEPTION 'b056_invalid_plan' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.organizations WHERE id = p_org FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'b056_forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT app.b056_enabled(p_org) THEN
    RAISE EXCEPTION 'b056_disabled' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.org_members m
     WHERE m.org_id = p_org AND m.user_id = p_actor AND m.role = 'admin' AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'b056_forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM app.b056_org_trials t WHERE t.org_id = p_org FOR UPDATE;
  v_existed := FOUND;
  IF v_existed AND v_row.trial_plan IS NOT NULL THEN
    RETURN QUERY SELECT false, 'trial_used'::text, v_row.trial_ends_at;
    RETURN;
  END IF;
  IF v_existed AND v_row.paid_plan IS NOT NULL THEN
    RETURN QUERY SELECT false, 'paid'::text, NULL::timestamptz;   -- OQ-B056-09
    RETURN;
  END IF;

  v_now := clock_timestamp();
  v_end := app.b056_trial_end(p_plan, v_now);
  IF v_existed THEN
    UPDATE app.b056_org_trials t
       SET trial_plan = p_plan, trial_source = 'settings', trial_started_at = v_now,
           trial_ends_at = v_end, started_by = p_actor, updated_at = v_now
     WHERE t.org_id = p_org
    RETURNING to_jsonb(t.*) INTO v_new;
  ELSE
    INSERT INTO app.b056_org_trials AS t (org_id, trial_plan, trial_source, trial_started_at, trial_ends_at, started_by, created_at, updated_at)
    VALUES (p_org, p_plan, 'settings', v_now, v_end, p_actor, v_now, v_now)
    RETURNING to_jsonb(t.*) INTO v_new;
  END IF;

  INSERT INTO public.audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, old_row, new_row, changed_cols, reason, request_id)
  VALUES (p_org, p_actor, 'admin', 'b056_org_trials', p_org::text,
          CASE WHEN v_existed THEN 'update' ELSE 'insert' END::public.audit_action,
          CASE WHEN v_existed THEN to_jsonb(v_row) END, v_new,
          ARRAY['trial_plan', 'trial_source', 'trial_started_at', 'trial_ends_at', 'started_by'],
          coalesce(nullif(current_setting('app.change_reason', true), ''), 'b056 trial start'),
          nullif(current_setting('app.request_id', true), ''));

  RETURN QUERY SELECT true, NULL::text, v_end;
END;
$$;

-- Record that a user saw or dismissed one banner of the current trial (MGT-98-AC2, per user).
-- The actor must be an active staff member of the org and the org must have a trial.
-- Idempotent: returns false when already recorded.
CREATE FUNCTION app.b056_dismiss_banner(p_org uuid, p_user uuid, p_kind text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_ends timestamptz;
  v_count integer;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('d14', 'd3', 'd1', 'expired') THEN
    RAISE EXCEPTION 'b056_invalid_banner' USING ERRCODE = '22023';
  END IF;
  IF NOT app.b056_enabled(p_org) THEN
    RAISE EXCEPTION 'b056_disabled' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.org_members m
     WHERE m.org_id = p_org AND m.user_id = p_user AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'b056_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT t.trial_ends_at INTO v_ends FROM app.b056_org_trials t
   WHERE t.org_id = p_org AND t.trial_plan IS NOT NULL;
  IF v_ends IS NULL THEN
    RAISE EXCEPTION 'b056_no_trial' USING ERRCODE = '55000';
  END IF;
  INSERT INTO app.b056_banner_dismissals (org_id, user_id, kind, trial_ends_at)
  VALUES (p_org, p_user, p_kind, v_ends)
  ON CONFLICT (org_id, user_id, kind) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

-- Banners this user has already seen or dismissed for the org's trial. Empty when flag OFF.
CREATE FUNCTION app.b056_banner_dismissed_kinds(p_org uuid, p_user uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(array_agg(d.kind ORDER BY d.kind), ARRAY[]::text[])
    FROM app.b056_banner_dismissals d
   WHERE d.org_id = p_org AND d.user_id = p_user AND app.b056_enabled(p_org)
$$;

-- EXECUTE: service_role only (svc() after the server-side check). Not on rpc-allowlist.txt.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'app.b056_enabled(uuid)',
    'app.b056_plan_facts(uuid)',
    'app.b056_trial_end(text, timestamptz)',
    'app.b056_start_trial(uuid, uuid, text)',
    'app.b056_dismiss_banner(uuid, uuid, text)',
    'app.b056_banner_dismissed_kinds(uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

COMMIT;
