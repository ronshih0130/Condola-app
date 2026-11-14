-- FILE: supabase/migrations/20261113220000_b042_today_home_schema.sql
-- B-042 PR-1 (narrowed): today-home foundation. Stories: MGT-36-AC5 (first-login landing is
-- recorded once), MGT-44-AC1 (setup step 3 = an invite shared by share / copy / QR / print —
-- Ron 2026-11-13 01:34 PT). Design note: condola-hub 20-build/specs/B-042-design.md r2.
-- The room_type value 'unspecified' (Ron 01:34 PT, OQ-B042-08) ships in PR-4a together with every
-- reader/writer that must handle it (Codex PR-1 r1: an unused value is still writable).
--
-- Additive only. Flags today_home and today_dash seeded OFF. Nothing in the app reads these
-- objects yet; while today_home is OFF every recorder refuses.
-- No change to organizations, properties, units, rooms, B-040 tables/functions, funnel_events,
-- usage_events or B-028. No outbound. No deletes.
--
-- Narrowed scope (OQ-B042-28): join attempts, bind events, room invite secrets, the B-028
-- center kinds and quick-create bookkeeping ship with PR-2 / PR-3 / PR-4a, because open design
-- findings #3/#4/#6/#7/#10 (receipts/b042/codex-review-design-r2.md) concern exactly those.
--
-- ADR-112 access path for every table below: definer-only. ENABLE + FORCE RLS, no policies,
-- REVOKE ALL from PUBLIC/anon/authenticated/service_role. Rows are reached only through the
-- SECURITY DEFINER functions below (EXECUTE to service_role only, called via svc() after the
-- server-side check).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Flags: effective only when platform_settings.<key>.enabled is boolean true AND allowed_org_ids
-- is an all-string array containing the org AND organizations.feature_flags.<key> is boolean true.
INSERT INTO public.platform_settings(key, value, description) VALUES
  ('today_home', '{"enabled":false,"allowed_org_ids":[]}'::jsonb,
   'B-042 今天 home, setup progress, quick unit create, bind notifications. Default OFF. Effective only with enabled true, the org in allowed_org_ids, and organizations.feature_flags.today_home true. First ON = Ron''s 4 internal orgs after QA 0 blockers and CEO exact-SHA GO.'),
  ('today_dash', '{"enabled":false,"allowed_org_ids":[]}'::jsonb,
   'B-042 今天 operations dashboard v1 (MGT-95). Default OFF. Same admission rule as today_home; requires today_home. First ON = Ron''s 4 internal orgs after QA 0 blockers and CEO exact-SHA GO.')
ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION app.b042_flag_on(p_key text, p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_key IN ('today_home', 'today_dash') AND EXISTS (
    SELECT 1 FROM public.platform_settings f JOIN public.organizations o ON o.id = p_org
     WHERE f.key = p_key
       AND jsonb_typeof(f.value) = 'object'
       AND f.value->'enabled' = 'true'::jsonb
       AND jsonb_typeof(f.value->'allowed_org_ids') = 'array'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.value->'allowed_org_ids') e WHERE jsonb_typeof(e) <> 'string')
       AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
       AND jsonb_typeof(o.feature_flags) = 'object'
       AND o.feature_flags->p_key = 'true'::jsonb)
$$;

-- SQL second line of defence (design note: "re-checks org, role, live environment and
-- sample_marks"): when the caller's transaction is pinned (app.env / app.active_org_id, see
-- 20261020180000_sandbox.sql), it must be pinned to this live org.
CREATE FUNCTION app.b042_session_pin_ok(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(nullif(current_setting('app.env', true), ''), 'live') = 'live'
     AND coalesce(nullif(current_setting('app.active_org_id', true), ''), p_org::text) = p_org::text
$$;

-- MGT-36-AC5: first sign-in per user per live org after today_home is ON (no backfill, OQ-B042-18).
CREATE TABLE app.b042_first_logins (
  org_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  first_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, user_id)
);
ALTER TABLE app.b042_first_logins ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b042_first_logins FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.b042_first_logins FROM PUBLIC, anon, authenticated, service_role;

-- MGT-44-AC1 / setup step 3: a durable record that an invite was shared, per secret and channel.
-- Only share / copy / QR / print count (Ron 01:34 PT); opening the link does not.
CREATE TABLE app.b042_invite_shares (
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  secret_kind text NOT NULL CHECK (secret_kind IN ('unit', 'room')),
  secret_id   uuid NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('line', 'copy', 'qr', 'print')),
  first_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  reported_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (secret_kind, secret_id, channel)
);
CREATE INDEX b042_invite_shares_org_idx ON app.b042_invite_shares (org_id, first_at);
ALTER TABLE app.b042_invite_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b042_invite_shares FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.b042_invite_shares FROM PUBLIC, anon, authenticated, service_role;

-- Record the first sign-in of an active, non-sample staff member in a live org. Idempotent: returns true
-- only for the call that stored it. Refuses while today_home is OFF for the org.
CREATE FUNCTION app.b042_record_first_login(p_org uuid, p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  IF NOT app.b042_flag_on('today_home', p_org) THEN
    RAISE EXCEPTION 'b042_disabled' USING ERRCODE = '55000';
  END IF;
  IF NOT app.b042_session_pin_ok(p_org) OR NOT EXISTS (
    SELECT 1 FROM public.org_members m JOIN public.organizations o ON o.id = m.org_id
     WHERE m.org_id = p_org AND m.user_id = p_user AND m.status = 'active' AND o.environment = 'live'
       AND NOT EXISTS (SELECT 1 FROM public.sample_marks sm
                        WHERE sm.org_id = p_org AND sm.entity_table = 'org_members' AND sm.entity_id = m.id)
  ) THEN
    RAISE EXCEPTION 'b042_forbidden' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.b042_first_logins (org_id, user_id) VALUES (p_org, p_user)
  ON CONFLICT (org_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

-- Whether the user's first sign-in in the org is already recorded. False while the flag is OFF.
CREATE FUNCTION app.b042_first_login_seen(p_org uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT app.b042_flag_on('today_home', p_org)
     AND EXISTS (SELECT 1 FROM app.b042_first_logins f WHERE f.org_id = p_org AND f.user_id = p_user)
$$;

-- Record that a staff member shared a live invite (MGT-44-AC1). The actor must be an active
-- admin or manager of the live org (same roles as B-040 staffCanManage); the secret must be a
-- live (unrevoked, unexpired) unit invite of that org. Room secrets arrive with PR-2 and are
-- refused until then. Idempotent per (secret, channel): returns true only when first stored.
CREATE FUNCTION app.b042_record_invite_share(p_org uuid, p_actor uuid, p_kind text, p_secret uuid, p_channel text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  IF p_channel IS NULL OR p_channel NOT IN ('line', 'copy', 'qr', 'print') THEN
    RAISE EXCEPTION 'b042_invalid_channel' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS DISTINCT FROM 'unit' THEN
    RAISE EXCEPTION 'b042_invalid_target' USING ERRCODE = '22023';
  END IF;
  IF NOT app.b042_flag_on('today_home', p_org) THEN
    RAISE EXCEPTION 'b042_disabled' USING ERRCODE = '55000';
  END IF;
  IF NOT app.b042_session_pin_ok(p_org) OR NOT EXISTS (
    SELECT 1 FROM public.org_members m JOIN public.organizations o ON o.id = m.org_id
     WHERE m.org_id = p_org AND m.user_id = p_actor AND m.status = 'active'
       AND m.role IN ('admin', 'manager') AND o.environment = 'live'
       AND NOT EXISTS (SELECT 1 FROM public.sample_marks sm
                        WHERE sm.org_id = p_org AND sm.entity_table = 'org_members' AND sm.entity_id = m.id)
  ) THEN
    RAISE EXCEPTION 'b042_forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.unit_invite_secrets s
     WHERE s.id = p_secret AND s.org_id = p_org AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'b042_not_found' USING ERRCODE = '42704';
  END IF;
  -- Sample data never counts toward real setup progress (unit, its property, or the secret).
  IF EXISTS (
    SELECT 1 FROM app.unit_invite_secrets s JOIN public.units u ON u.id = s.unit_id
      JOIN public.sample_marks sm ON sm.org_id = p_org
       AND ((sm.entity_table = 'units' AND sm.entity_id = u.id)
         OR (sm.entity_table = 'properties' AND sm.entity_id = u.property_id)
         OR (sm.entity_table = 'unit_invite_secrets' AND sm.entity_id = s.id))
     WHERE s.id = p_secret
  ) THEN
    RAISE EXCEPTION 'b042_sample' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.b042_invite_shares (org_id, secret_kind, secret_id, channel, reported_by)
  VALUES (p_org, p_kind, p_secret, p_channel, p_actor)
  ON CONFLICT (secret_kind, secret_id, channel) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

-- Setup step 3 source (MGT-44-AC1): has any invite of this live org been shared? False when OFF.
CREATE FUNCTION app.b042_org_invite_shared(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT app.b042_flag_on('today_home', p_org)
     AND EXISTS (SELECT 1 FROM app.b042_invite_shares s WHERE s.org_id = p_org)
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'app.b042_flag_on(text, uuid)',
    'app.b042_session_pin_ok(uuid)',
    'app.b042_record_first_login(uuid, uuid)',
    'app.b042_first_login_seen(uuid, uuid)',
    'app.b042_record_invite_share(uuid, uuid, text, uuid, text)',
    'app.b042_org_invite_shared(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

COMMIT;
