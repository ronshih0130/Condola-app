-- FILE: supabase/migrations/20261114100000_b042_fix_forward.sql
-- B-042 fix-forward carried from the CEO GO on PR-1 (#143, exact SHA 7d4faef); binding text:
-- condola-hub 20-build/specs/B-042-design-r3-final.md "Fix-forward carried into PR-4a".
--
--   1. Session pin REQUIRED. The recorders only run inside a transaction pinned to this live
--      org (app.env = 'live' AND app.active_org_id = the org). PR-1 only refused a wrong pin
--      and accepted a missing one.
--   2. today_dash requires today_home. b042_flag_on('today_dash', org) is false unless
--      today_home is also on for that org.
--   3. (tests only) anon and authenticated calling each app.b042_* function are denied.
--
-- Two functions are replaced with the same signature, language, volatility and owner. No table,
-- column, policy or grant changes; privileges are re-asserted. Flags stay OFF, and nothing in the
-- app calls these functions yet. The room_type value 'unspecified' is NOT in this migration: it
-- ships with its readers and writers.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- A flag is on for an org only when platform_settings.<key>.enabled is boolean true AND
-- allowed_org_ids is an all-string array containing the org AND
-- organizations.feature_flags.<key> is boolean true. today_dash also needs all of that for
-- today_home. Any other key is never on.
CREATE OR REPLACE FUNCTION app.b042_flag_on(p_key text, p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_key IS NOT NULL AND p_org IS NOT NULL
     AND p_key IN ('today_home', 'today_dash')
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(CASE WHEN p_key = 'today_dash'
                          THEN ARRAY['today_home', 'today_dash']
                          ELSE ARRAY['today_home'] END) AS need(k)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.platform_settings f JOIN public.organizations o ON o.id = p_org
           WHERE f.key = need.k
             AND jsonb_typeof(f.value) = 'object'
             AND f.value->'enabled' = 'true'::jsonb
             AND jsonb_typeof(f.value->'allowed_org_ids') = 'array'
             -- The CASE makes the expansion safe by itself: SQL does not promise that the
             -- jsonb_typeof check above is evaluated first (Codex fix-forward r1, minor 3).
             AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(
                               CASE WHEN jsonb_typeof(f.value->'allowed_org_ids') = 'array'
                                    THEN f.value->'allowed_org_ids' ELSE '[]'::jsonb END) e
                              WHERE jsonb_typeof(e) <> 'string')
             AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
             AND jsonb_typeof(o.feature_flags) = 'object'
             AND o.feature_flags->need.k = 'true'::jsonb))
$$;

-- The caller's transaction must be pinned to this live org (see 20261020180000_sandbox.sql and
-- pinOrg in src/server/db.ts). A missing, empty or different pin is refused. The result is
-- never NULL, so "IF NOT app.b042_session_pin_ok(...)" cannot fall through.
CREATE OR REPLACE FUNCTION app.b042_session_pin_ok(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    p_org IS NOT NULL
    AND current_setting('app.env', true) = 'live'
    AND current_setting('app.active_org_id', true) = p_org::text,
    false)
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'app.b042_flag_on(text, uuid)',
    'app.b042_session_pin_ok(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

COMMIT;
