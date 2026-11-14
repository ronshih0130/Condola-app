-- FILE: supabase/migrations/20261114000000_b056_pr3a_pause_predicate.sql
-- B-056 PR-3a (pause predicate in SQL before materialisation). Stories: MGT-99-AC1, MGT-99-AC5.
-- Design: condola-hub 20-build/specs/B-056-design-r3-final.md #4 (binding) and the fix-forward
-- list carried from the #139 GO; r2 design 20-build/specs/B-056-design.md. PR-3 is split into
-- 3a (this file: pause), 3b (snapshot builder, markers, app.b056_readonly_guard trigger) and 3c
-- (server withSpaceGuard and tenant-write gateways); OQ-B056-30.
--
-- What changes:
--   1. app.b056_org_trials.kept_member_id (nullable). Set by the PR-4 expiry job; until then the
--      predicate derives the kept member (earliest-joined active admin, tie by id; OQ-B056-02).
--   2. app.b056_org_trials.org_id FK: ON DELETE CASCADE -> ON DELETE RESTRICT (#139 GO fix-forward).
--   3. app.b056_member_paused(org, user): SECURITY DEFINER, non-recursive (reads tables directly,
--      never app.is_member/app.has_role or any RLS-protected view). Constant false while the
--      pricing_trial flag is OFF globally or for the org. True from trial_ends_at (00:00:00
--      Asia/Taipei of the end date) for every member except the kept one, while no paid plan is
--      recorded. A sandbox org resolves to its live org, so the live-org pause applies there too.
--   4. CREATE OR REPLACE of app.is_member, app.has_role and every other function that anon or
--      authenticated can effectively EXECUTE and that checks active membership inline
--      (b010_confirmation_audit, b010_lock_payment_context, b017_denied_orgs). Each body is the
--      current definition with `AND NOT app.b056_member_paused(m.org_id, m.user_id)` appended to
--      its `m.status = 'active'` test; nothing else changes. Owner and grants are kept by
--      CREATE OR REPLACE. app.b027_any_org_member is status-agnostic and only used as
--      NOT any_org_member (it excludes staff from tenant paths), so a paused member stays
--      excluded; app.prop04_my_consent_records already calls app.is_member. The PR-3a inventory
--      test enumerates these from the catalog (has_function_privilege), not rpc-allowlist.txt.
--
-- With the flag OFF (seed: enabled false, empty allowlist) every changed function returns
-- exactly what it returned before. Additive; no deletes; no outbound; no grant to anon or
-- authenticated on any new object.
--
-- ADR-112 access path: app.b056_member_paused is definer-only. EXECUTE is revoked from PUBLIC,
-- anon and authenticated and granted to service_role; the owner-path session query
-- (resolveStaffOrg) and the SECURITY DEFINER helpers call it as the owning login.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.b056_org_trials ADD COLUMN kept_member_id uuid NULL;
ALTER TABLE app.b056_org_trials
  ADD CONSTRAINT b056_org_trials_kept_member_fkey
  FOREIGN KEY (org_id, kept_member_id) REFERENCES public.org_members(org_id, id) ON DELETE RESTRICT;

ALTER TABLE app.b056_org_trials DROP CONSTRAINT b056_org_trials_org_id_fkey;
ALTER TABLE app.b056_org_trials
  ADD CONSTRAINT b056_org_trials_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

CREATE FUNCTION app.b056_member_paused(p_org uuid, p_user uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org  uuid;
  v_ends timestamptz;
  v_paid text;
  v_kept uuid;
BEGIN
  IF p_org IS NULL OR p_user IS NULL THEN
    RETURN false;
  END IF;
  -- Flag OFF globally: constant false before any per-org read.
  IF NOT EXISTS (SELECT 1 FROM public.platform_settings f
                  WHERE f.key = 'pricing_trial' AND f.value->'enabled' = 'true'::jsonb) THEN
    RETURN false;
  END IF;
  SELECT CASE WHEN o.environment = 'sandbox' THEN o.live_org_id ELSE o.id END
    INTO v_org FROM public.organizations o WHERE o.id = p_org;
  IF v_org IS NULL OR NOT app.b056_enabled(v_org) THEN
    RETURN false;
  END IF;
  SELECT t.trial_ends_at, t.paid_plan, t.kept_member_id
    INTO v_ends, v_paid, v_kept
    FROM app.b056_org_trials t WHERE t.org_id = v_org;
  -- No trial, a paid plan, or still before 00:00 Taipei of the end date: not paused.
  IF v_ends IS NULL OR v_paid IS NOT NULL OR clock_timestamp() < v_ends THEN
    RETURN false;
  END IF;
  IF v_kept IS NULL THEN
    SELECT m.id INTO v_kept FROM public.org_members m
     WHERE m.org_id = v_org AND m.role = 'admin' AND m.status = 'active'
     ORDER BY m.created_at, m.id LIMIT 1;
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM public.org_members m
                      WHERE m.id = v_kept AND m.org_id = v_org AND m.user_id = p_user);
END $$;
REVOKE EXECUTE ON FUNCTION app.b056_member_paused(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.b056_member_paused(uuid, uuid) TO service_role;

-- app.is_member: current definition + pause predicate
CREATE OR REPLACE FUNCTION app.is_member(p_org uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  active text := nullif(current_setting('app.active_org_id', true), '');
  env_name text := nullif(current_setting('app.env', true), '');
  org_env text;
  live_id uuid;
BEGIN
  SELECT environment::text, live_org_id INTO org_env, live_id FROM organizations WHERE id = p_org;
  IF org_env IS NULL THEN
    RETURN false;
  END IF;
  IF org_env = 'sandbox' THEN
    IF active IS NULL OR active <> p_org::text OR env_name IS DISTINCT FROM 'sandbox' THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.user_id = auth.uid() AND m.status = 'active' AND NOT app.b056_member_paused(m.org_id, m.user_id)
         AND (m.org_id = p_org OR m.org_id = live_id)
    );
  END IF;
  IF active IS NOT NULL AND active <> p_org::text THEN
    RETURN false;
  END IF;
  IF env_name = 'sandbox' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM org_members m
     WHERE m.org_id = p_org AND m.user_id = auth.uid() AND m.status = 'active' AND NOT app.b056_member_paused(m.org_id, m.user_id)
  );
END $function$
;

-- app.has_role: current definition + pause predicate
CREATE OR REPLACE FUNCTION app.has_role(p_org uuid, p_roles org_role[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT app.is_member(p_org) AND EXISTS (
    SELECT 1
      FROM org_members m
      JOIN organizations o ON o.id = p_org
     WHERE m.user_id = auth.uid()
       AND m.status = 'active' AND NOT app.b056_member_paused(m.org_id, m.user_id)
       AND m.role = ANY (p_roles)
       AND (m.org_id = p_org OR m.org_id = o.live_org_id)
  )
$function$
;

-- app.b010_confirmation_audit: current definition + pause predicate
CREATE OR REPLACE FUNCTION app.b010_confirmation_audit(p_payment uuid)
 RETURNS TABLE(actor_user_id uuid, on_behalf_of_owner_contact_id uuid, confirmed_via text, source text, from_status text, to_status text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
  SELECT c.actor_user_id, c.on_behalf_of_owner_contact_id, c.confirmed_via,
    c.source, c.from_status, c.to_status, c.created_at
  FROM app.b010_payment_confirmations c
  JOIN public.payments p ON p.org_id=c.org_id AND p.id=c.payment_id
  WHERE p.id=p_payment
    AND (
      EXISTS (
        SELECT 1
        FROM public.organizations o
        JOIN public.org_members m
          ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
        WHERE o.id=p.org_id
          AND m.user_id=auth.uid()
          AND m.status='active' AND NOT app.b056_member_paused(m.org_id, m.user_id)
      )
      OR EXISTS (
        SELECT 1 FROM public.contacts owner_contact
        WHERE owner_contact.org_id=c.org_id
          AND owner_contact.id=c.on_behalf_of_owner_contact_id
          AND owner_contact.user_id=auth.uid()
      )
    );
$function$
;

-- app.b010_lock_payment_context: current definition + pause predicate
CREATE OR REPLACE FUNCTION app.b010_lock_payment_context(p_org uuid, p_live_org uuid, p_environment text, p_session uuid, p_lease uuid, p_role text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_actor uuid:=auth.uid();
  v_enabled boolean;
  v_attempt integer;
  v_deadline timestamptz;
  v_remaining double precision;
BEGIN
  -- Scope authorization also applies when rollout is OFF.
  -- Validate membership and scope before acquiring privileged locks.
  IF NOT EXISTS (SELECT 1 FROM public.organizations o JOIN public.org_members m
      ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
    WHERE o.id=p_org AND o.environment::text=p_environment
      AND ((o.environment='live' AND o.id=p_live_org AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live_org))
      AND m.user_id=v_actor AND m.status='active' AND NOT app.b056_member_paused(m.org_id, m.user_id) AND m.role::text=p_role AND m.role IN ('admin','manager','accountant')) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='payment_results_v2'
    WHERE o.id=p_org AND o.feature_flags->'payment_results_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
  IF NOT v_enabled THEN RETURN false; END IF;

  FOR v_attempt IN 1..3 LOOP
    BEGIN
      v_deadline:=clock_timestamp()+interval '2 seconds';
      LOOP
        BEGIN
          LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
          PERFORM 1 FROM public.organizations o
            WHERE o.id IN (p_org,p_live_org) ORDER BY o.id FOR SHARE NOWAIT;

          SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='payment_results_v2'
            WHERE o.id=p_org AND o.feature_flags->'payment_results_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
              AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;

          IF v_enabled THEN
            PERFORM 1 FROM public.organizations o JOIN public.org_members m
              ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
              WHERE o.id=p_org AND o.environment::text=p_environment
                AND ((o.environment='live' AND o.id=p_live_org AND o.live_org_id IS NULL)
                  OR (o.environment='sandbox' AND o.live_org_id=p_live_org))
                AND m.user_id=v_actor AND m.status='active' AND NOT app.b056_member_paused(m.org_id, m.user_id)
                AND m.role::text=p_role AND m.role IN ('admin','manager','accountant')
              FOR SHARE OF m NOWAIT;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
            END IF;

            PERFORM 1 FROM public.auth_sessions s
              WHERE s.id=p_session AND s.user_id=v_actor
                AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
              FOR SHARE NOWAIT;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
            END IF;

            PERFORM 1 FROM public.leases
              WHERE id=p_lease AND org_id=p_org FOR SHARE NOWAIT;
            IF NOT FOUND OR NOT EXISTS (
              SELECT 1 FROM public.auth_sessions s
              WHERE s.id=p_session AND s.user_id=v_actor
                AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
            ) THEN
              RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
            END IF;
          END IF;
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
        RAISE EXCEPTION 'Payment result busy' USING ERRCODE='55P03';
      END IF;
      PERFORM pg_sleep(0.05*v_attempt);
    END;
  END LOOP;

  IF NOT v_enabled THEN RETURN false; END IF;
  INSERT INTO app.b010_payment_contexts(tx_id,org_id,lease_id,actor_id,session_id,role)
    VALUES(txid_current(),p_org,p_lease,v_actor,p_session,p_role)
    ON CONFLICT(tx_id,org_id,lease_id,actor_id)
      DO UPDATE SET session_id=EXCLUDED.session_id,role=EXCLUDED.role;
  RETURN true;
END $function$
;

-- app.b017_denied_orgs: current definition + pause predicate
CREATE OR REPLACE FUNCTION app.b017_denied_orgs(p_floor text)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
 SELECT coalesce(array_agg(o.id),ARRAY[]::uuid[])
 FROM public.org_members m JOIN public.organizations o
 ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
 WHERE m.user_id=auth.uid() AND app.b017_enabled(m.org_id)
 AND CASE p_floor
 WHEN 'photo' THEN NOT coalesce(m.status='active' AND NOT app.b056_member_paused(m.org_id, m.user_id) AND m.role<>'accountant'
   AND 'tickets.update'=ANY(app.b017_effective(m.org_id,m.user_id)),false)
 WHEN 'audit' THEN NOT coalesce(m.status='active' AND NOT app.b056_member_paused(m.org_id, m.user_id) AND m.role='admin'
   AND app.b017_effective(m.org_id,m.user_id) IS NOT NULL,false)
 ELSE true END
$function$
;

COMMIT;
