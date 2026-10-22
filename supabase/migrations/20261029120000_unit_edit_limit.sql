-- Over-4-unit edit limit.
-- After the trial ends, every unit stays editable for the grace period.
-- After that, only the admin's 4 units stay editable (default: earliest created).
-- Read-only units can still record and reverse payments. This migration does
-- not add a policy on payments.
--
-- Additive only: nullable columns, defaults, functions, and restrictive
-- policies. No NOT NULL. No CHECK. Old writers that never set these columns
-- keep working, and a firm with no recorded trial end is not locked.
--
-- Rollback:
--   DROP POLICY IF EXISTS unit_readonly_update ON units;
--   DROP POLICY IF EXISTS unit_readonly_delete ON units;
--   DROP POLICY IF EXISTS room_readonly_update ON rooms;
--   DROP POLICY IF EXISTS room_readonly_delete ON rooms;
--   DROP POLICY IF EXISTS lease_readonly_insert ON leases;
--   DROP POLICY IF EXISTS lease_readonly_update ON leases;
--   DROP POLICY IF EXISTS lease_readonly_delete ON leases;
--   DROP FUNCTION IF EXISTS app.set_kept_units(uuid, uuid[]);
--   DROP FUNCTION IF EXISTS app.sync_billed_units(uuid, integer, date);
--   DROP FUNCTION IF EXISTS app.unit_limit_state(uuid);
--   DROP FUNCTION IF EXISTS app.unit_row_editable(uuid, uuid);
--   DROP FUNCTION IF EXISTS app.space_editable(uuid, uuid);
--   DROP FUNCTION IF EXISTS app.kept_space_ids(uuid);
--   DROP FUNCTION IF EXISTS app.unit_limit_phase(uuid);
--   DROP FUNCTION IF EXISTS app.period_end_on(date, text);
--   DROP FUNCTION IF EXISTS app.portfolio_spaces(uuid);
--   DROP FUNCTION IF EXISTS app.trial_end(timestamptz, integer);
--   DROP FUNCTION IF EXISTS app.trial_mode();
--   DROP FUNCTION IF EXISTS app.trial_setting_int(text);
--   ALTER TABLE organizations
--     DROP COLUMN IF EXISTS kept_unit_ids,
--     DROP COLUMN IF EXISTS billing_period_end,
--     DROP COLUMN IF EXISTS billed_unit_count,
--     DROP COLUMN IF EXISTS pending_unit_count,
--     DROP COLUMN IF EXISTS billing_cycle;
--   DELETE FROM platform_settings
--    WHERE key IN ('trial_mode', 'trial_months', 'trial_days', 'unit_grace_days', 'free_editable_units');

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS kept_unit_ids uuid[],
  ADD COLUMN IF NOT EXISTS billing_period_end date,
  ADD COLUMN IF NOT EXISTS billed_unit_count integer,
  ADD COLUMN IF NOT EXISTS pending_unit_count integer,
  ADD COLUMN IF NOT EXISTS billing_cycle text;

INSERT INTO platform_settings (key, value, description) VALUES
  ('trial_mode', '"calendar_months"', 'TRIAL_MODE: calendar_months (default) or days90.'),
  ('trial_months', '3', 'Calendar-month trial length when the firm has no partner trial_months.'),
  ('trial_days', '90', 'Length of the days90 trial mode.'),
  ('unit_grace_days', '30', 'Days after the trial ends while every unit stays editable.'),
  ('free_editable_units', '4', 'How many units stay editable after the grace period.')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION app.trial_setting_int(p_key text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (value #>> '{}')::int FROM platform_settings WHERE key = p_key
$$;

-- calendar_months unless the session or platform setting says days90.
CREATE OR REPLACE FUNCTION app.trial_mode() RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN coalesce(
           nullif(current_setting('app.trial_mode', true), ''),
           (SELECT value #>> '{}' FROM platform_settings WHERE key = 'trial_mode'),
           'calendar_months'
         ) = 'days90'
    THEN 'days90'
    ELSE 'calendar_months'
  END
$$;

-- Trial end. days90 reads trial_days. calendar_months adds p_months, or trial_months when p_months is null.
-- Month arithmetic is in UTC so the session TimeZone cannot change the length.
CREATE OR REPLACE FUNCTION app.trial_end(p_start timestamptz, p_months integer) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_months integer;
  v_days integer;
BEGIN
  IF app.trial_mode() = 'days90' THEN
    v_days := coalesce(
      nullif(current_setting('app.trial_days', true), '')::int,
      app.trial_setting_int('trial_days')
    );
    IF v_days IS NULL THEN
      RAISE EXCEPTION 'trial_days is not configured';
    END IF;
    RETURN p_start + make_interval(days => v_days);
  END IF;
  v_months := coalesce(p_months, app.trial_setting_int('trial_months'));
  IF v_months IS NULL THEN
    RAISE EXCEPTION 'trial_months is not configured';
  END IF;
  RETURN (p_start AT TIME ZONE 'UTC' + make_interval(months => GREATEST(v_months, 0))) AT TIME ZONE 'UTC';
END;
$$;

-- A rentable space is a whole unit, or a room inside a by-room unit.
CREATE OR REPLACE FUNCTION app.portfolio_spaces(p_org uuid)
RETURNS TABLE (id uuid, created_at timestamptz, kind text, label text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.created_at, 'whole_unit'::text,
         trim(both ' ' FROM p.name || ' ' || u.label)
    FROM units u
    JOIN properties p ON p.id = u.property_id
   WHERE u.org_id = p_org AND u.archived_at IS NULL AND u.rental_mode = 'whole_unit'
     AND p.archived_at IS NULL
  UNION ALL
  SELECT r.id, r.created_at, 'room'::text,
         trim(both ' ' FROM p.name || ' ' || u.label || ' ' || r.label)
    FROM rooms r
    JOIN units u ON u.id = r.unit_id AND u.org_id = r.org_id
    JOIN properties p ON p.id = u.property_id
   WHERE r.org_id = p_org AND r.archived_at IS NULL AND u.archived_at IS NULL
     AND u.rental_mode = 'by_room' AND p.archived_at IS NULL
$$;

-- open | trial | grace | locked. No recorded trial end stays open so existing firms are not locked.
CREATE OR REPLACE FUNCTION app.unit_limit_phase(p_org uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_env text;
  v_tier text;
  v_settings jsonb;
  v_plan text;
  v_trial timestamptz;
  v_free integer;
  v_grace integer;
  v_count integer;
BEGIN
  SELECT o.environment::text, o.plan_tier::text, o.settings
    INTO v_env, v_tier, v_settings
    FROM organizations o
   WHERE o.id = p_org;
  IF NOT FOUND THEN
    RETURN 'open';
  END IF;
  v_plan := coalesce(nullif(v_settings #>> '{plan,tier}', ''), v_tier, 'free');
  IF v_env = 'sandbox' OR v_plan IN ('standard', 'pro', 'business') THEN
    RETURN 'open';
  END IF;
  v_free := coalesce(app.trial_setting_int('free_editable_units'), 4);
  SELECT count(*)::int INTO v_count FROM app.portfolio_spaces(p_org);
  IF v_count <= v_free THEN
    RETURN 'open';
  END IF;
  BEGIN
    v_trial := nullif(v_settings #>> '{plan,trialUntil}', '')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    v_trial := NULL;
  END;
  IF v_trial IS NULL THEN
    RETURN 'open';
  END IF;
  IF now() < v_trial THEN
    RETURN 'trial';
  END IF;
  v_grace := coalesce(app.trial_setting_int('unit_grace_days'), 30);
  IF now() < v_trial + make_interval(days => v_grace) THEN
    RETURN 'grace';
  END IF;
  RETURN 'locked';
END;
$$;

-- Explicit pick when the admin has saved one. Otherwise the earliest-created spaces.
CREATE OR REPLACE FUNCTION app.kept_space_ids(p_org uuid) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_free integer;
  v_raw uuid[];
BEGIN
  v_free := coalesce(app.trial_setting_int('free_editable_units'), 4);
  SELECT kept_unit_ids INTO v_raw FROM organizations WHERE id = p_org;
  IF v_raw IS NOT NULL AND cardinality(v_raw) > 0
     AND EXISTS (
       SELECT 1
         FROM unnest(v_raw) AS picked(id)
         JOIN app.portfolio_spaces(p_org) s ON s.id = picked.id
     ) THEN
    RETURN QUERY
      SELECT picked.id
        FROM unnest(v_raw) WITH ORDINALITY AS picked(id, ord)
        JOIN app.portfolio_spaces(p_org) s ON s.id = picked.id
       GROUP BY picked.id
       ORDER BY min(picked.ord)
       LIMIT v_free;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT s.id
      FROM app.portfolio_spaces(p_org) s
     ORDER BY s.created_at, s.id
     LIMIT v_free;
END;
$$;

CREATE OR REPLACE FUNCTION app.space_editable(p_org uuid, p_space uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_space IS NULL OR app.unit_limit_phase(p_org) <> 'locked' THEN
    RETURN true;
  END IF;
  RETURN EXISTS (SELECT 1 FROM app.kept_space_ids(p_org) k WHERE k = p_space);
END;
$$;

-- A by-room unit row stays writable when one of its rooms is still editable,
-- so saving that room can touch the parent floor row.
CREATE OR REPLACE FUNCTION app.unit_row_editable(p_org uuid, p_unit uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.space_editable(p_org, p_unit)
      OR EXISTS (
           SELECT 1 FROM rooms r
            WHERE r.unit_id = p_unit AND r.org_id = p_org
              AND app.space_editable(p_org, r.id)
         )
$$;

CREATE OR REPLACE FUNCTION app.period_end_on(p_today date, p_cycle text) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_cycle = 'year' THEN (p_today + interval '1 year' - interval '1 day')::date
    ELSE (date_trunc('month', p_today::timestamp) + interval '1 month' - interval '1 day')::date
  END
$$;

-- The billed unit count changes on the next period. p_active is the live count.
-- A null p_today uses the firm's timezone (Asia/Taipei when unset).
CREATE OR REPLACE FUNCTION app.sync_billed_units(p_org uuid, p_active integer, p_today date)
RETURNS TABLE (billed integer, pending integer, period_end date, active integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_billed integer;
  v_pending integer;
  v_end date;
  v_cycle text;
  v_today date;
  v_tz text;
  v_new_billed integer;
  v_new_pending integer;
  v_new_end date;
  v_base integer;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT app.is_member(p_org) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  SELECT o.billed_unit_count, o.pending_unit_count, o.billing_period_end,
         CASE WHEN o.billing_cycle = 'year' THEN 'year' ELSE 'month' END,
         coalesce(nullif(o.timezone, ''), 'Asia/Taipei')
    INTO v_billed, v_pending, v_end, v_cycle, v_tz
    FROM organizations o
   WHERE o.id = p_org
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  v_today := coalesce(p_today, (timezone(v_tz, now()))::date);
  IF v_end IS NULL OR v_today > v_end THEN
    IF v_end IS NOT NULL AND v_today > v_end THEN
      v_new_billed := coalesce(v_pending, p_active);
    ELSE
      v_new_billed := p_active;
    END IF;
    v_new_pending := CASE WHEN v_new_billed IS NOT DISTINCT FROM p_active THEN NULL ELSE p_active END;
    v_new_end := app.period_end_on(v_today, v_cycle);
  ELSE
    v_base := coalesce(v_billed, p_active);
    v_new_billed := v_base;
    v_new_pending := CASE WHEN p_active IS NOT DISTINCT FROM v_base THEN NULL ELSE p_active END;
    v_new_end := v_end;
  END IF;
  IF v_billed IS DISTINCT FROM v_new_billed
     OR v_pending IS DISTINCT FROM v_new_pending
     OR v_end IS DISTINCT FROM v_new_end THEN
    UPDATE organizations
       SET billed_unit_count = v_new_billed,
           pending_unit_count = v_new_pending,
           billing_period_end = v_new_end,
           updated_at = now()
     WHERE id = p_org;
  END IF;
  billed := v_new_billed;
  pending := v_new_pending;
  period_end := v_new_end;
  active := p_active;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION app.unit_limit_state(p_org uuid)
RETURNS TABLE (
  phase text,
  grace_days_left integer,
  space_count integer,
  trial_until timestamptz,
  grace_until timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_settings jsonb;
  v_trial timestamptz;
  v_grace integer;
  v_left integer;
BEGIN
  phase := app.unit_limit_phase(p_org);
  SELECT count(*)::int INTO space_count FROM app.portfolio_spaces(p_org);
  SELECT settings INTO v_settings FROM organizations WHERE id = p_org;
  BEGIN
    v_trial := nullif(v_settings #>> '{plan,trialUntil}', '')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    v_trial := NULL;
  END;
  trial_until := v_trial;
  v_grace := coalesce(app.trial_setting_int('unit_grace_days'), 30);
  IF v_trial IS NULL THEN
    grace_until := NULL;
    grace_days_left := 0;
  ELSE
    grace_until := v_trial + make_interval(days => v_grace);
    v_left := ceil(extract(epoch FROM (grace_until - now())) / 86400.0)::int;
    grace_days_left := GREATEST(v_left, 0);
  END IF;
  RETURN NEXT;
END;
$$;

-- Admin only. An empty list clears the pick and restores the earliest-created default.
-- A save must name exactly the free-unit count, and every id must be a current space.
CREATE OR REPLACE FUNCTION app.set_kept_units(p_org uuid, p_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_free integer;
  v_clean uuid[];
BEGIN
  IF auth.uid() IS NULL OR NOT app.has_role(p_org, '{admin}') THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  v_free := coalesce(app.trial_setting_int('free_editable_units'), 4);
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    UPDATE organizations SET kept_unit_ids = NULL, updated_at = now() WHERE id = p_org;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM unnest(p_ids) AS picked(id)
     WHERE NOT EXISTS (SELECT 1 FROM app.portfolio_spaces(p_org) s WHERE s.id = picked.id)
  ) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  SELECT ARRAY(
    SELECT picked.id
      FROM unnest(p_ids) WITH ORDINALITY AS picked(id, ord)
     GROUP BY picked.id
     ORDER BY min(picked.ord)
  ) INTO v_clean;
  IF v_clean IS NULL OR cardinality(v_clean) <> v_free THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  UPDATE organizations SET kept_unit_ids = v_clean, updated_at = now() WHERE id = p_org;
END;
$$;

REVOKE ALL ON FUNCTION app.trial_setting_int(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.trial_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.trial_end(timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.portfolio_spaces(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.unit_limit_phase(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.kept_space_ids(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.space_editable(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.unit_row_editable(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.period_end_on(date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.sync_billed_units(uuid, integer, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.unit_limit_state(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_kept_units(uuid, uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.trial_setting_int(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.trial_mode() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.trial_end(timestamptz, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.portfolio_spaces(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.unit_limit_phase(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.kept_space_ids(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.space_editable(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.unit_row_editable(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.period_end_on(date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.sync_billed_units(uuid, integer, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.unit_limit_state(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.set_kept_units(uuid, uuid[]) TO authenticated, service_role;

-- Restrictive policies AND with the existing team policies. SELECT stays open.
-- Payments are intentionally left alone.
DROP POLICY IF EXISTS unit_readonly_update ON units;
CREATE POLICY unit_readonly_update ON units
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (app.unit_row_editable(org_id, id))
  WITH CHECK (app.unit_row_editable(org_id, id));

DROP POLICY IF EXISTS unit_readonly_delete ON units;
CREATE POLICY unit_readonly_delete ON units
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (app.unit_row_editable(org_id, id));

DROP POLICY IF EXISTS room_readonly_update ON rooms;
CREATE POLICY room_readonly_update ON rooms
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (app.space_editable(org_id, id))
  WITH CHECK (app.space_editable(org_id, id));

DROP POLICY IF EXISTS room_readonly_delete ON rooms;
CREATE POLICY room_readonly_delete ON rooms
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (app.space_editable(org_id, id));

DROP POLICY IF EXISTS lease_readonly_insert ON leases;
CREATE POLICY lease_readonly_insert ON leases
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (app.space_editable(org_id, coalesce(target_room_id, target_unit_id)));

DROP POLICY IF EXISTS lease_readonly_update ON leases;
CREATE POLICY lease_readonly_update ON leases
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (app.space_editable(org_id, coalesce(target_room_id, target_unit_id)))
  WITH CHECK (app.space_editable(org_id, coalesce(target_room_id, target_unit_id)));

DROP POLICY IF EXISTS lease_readonly_delete ON leases;
CREATE POLICY lease_readonly_delete ON leases
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (app.space_editable(org_id, coalesce(target_room_id, target_unit_id)));
