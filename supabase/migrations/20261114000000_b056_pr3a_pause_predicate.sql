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
--      authenticated can effectively EXECUTE or reach, and that checks active membership inline
--      (b010_confirmation_audit, b010_lock_payment_context, b017_denied_orgs). Each body is the
--      current definition with `AND NOT app.b056_member_paused(m.org_id, m.user_id)` appended to
--      its `m.status = 'active'` test; nothing else changes. Owner and grants are kept by
--      CREATE OR REPLACE. The same applies to the definer helpers those functions, or triggers
--      on API-writable tables, reach (call-graph closure): b008_capture_first_period,
--      b017_effective, b017_invite_guard, b017_member_guard and b027_scope (behind
--      b027_read_controls). Not changed, by design: app.b027_any_org_member,
--      app.b022_my_owner_contact and app.b022_reply_statement use membership only to EXCLUDE
--      staff from owner/tenant paths, so a paused member stays excluded (stricter);
--      app.b017_preserve_admin is the last-usable-admin invariant; app.prop04_my_consent_records
--      already calls app.is_member. The PR-3a inventory test computes the closure from the
--      catalog (has_function_privilege + pg_trigger), not rpc-allowlist.txt.
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

-- Definer helpers reached indirectly from API-executable functions or from triggers on
-- API-writable tables (call-graph closure; Codex PR-3a r1). Same rule: current body plus the
-- pause predicate on each active-membership test that grants access.
-- app.b008_capture_first_period: current definition + pause predicate
CREATE OR REPLACE FUNCTION app.b008_capture_first_period(p_lease uuid, p_prorate boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_env text;
  v_global jsonb;
  v_flags jsonb;
  v_lease public.leases;
  v_enabled boolean;
  v_basis jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Retry transaction' USING ERRCODE='40001'; END IF;
  IF v_user IS NULL OR p_prorate IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
  BEGIN
    v_org := nullif(current_setting('app.active_org_id',true),'')::uuid;
    v_env := nullif(current_setting('app.env',true),'');
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
  END;
  IF v_org IS NULL OR v_env NOT IN ('live','sandbox') THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;

  SELECT value INTO v_global FROM public.platform_settings WHERE key='billing_previews' FOR SHARE;
  SELECT o.feature_flags INTO v_flags
    FROM public.organizations o
    JOIN public.organizations live ON live.id=coalesce(o.live_org_id,o.id) AND live.environment='live'
    JOIN public.org_members m ON m.org_id=live.id AND m.user_id=v_user AND m.status='active' AND NOT app.b056_member_paused(m.org_id, m.user_id) AND m.role IN ('admin','manager')
   WHERE o.id=v_org AND o.environment::text=v_env
     AND ((o.environment='live' AND o.id=live.id) OR (o.environment='sandbox' AND o.live_org_id=live.id))
   FOR SHARE OF o,live,m;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
  v_enabled := coalesce(v_global->'enabled'='true'::jsonb,false)
    AND jsonb_typeof(v_global->'allowed_org_ids')='array'
    AND (v_global->'allowed_org_ids') @> jsonb_build_array(v_org::text)
    AND coalesce(v_flags->'billing_previews'='true'::jsonb,false);
  v_enabled := coalesce(v_enabled,false);

  SELECT * INTO v_lease FROM public.leases WHERE id=p_lease AND org_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  IF NOT v_enabled AND (v_lease.first_period_basis IS NULL OR (v_lease.first_period_basis->'prorateFirstPeriod') IS DISTINCT FROM to_jsonb(p_prorate)) THEN
    RAISE EXCEPTION 'Feature unavailable' USING ERRCODE='42501';
  END IF;
  IF v_lease.rent_frequency::text <> 'monthly' OR v_lease.currency NOT IN ('TWD','USD') THEN
    RAISE EXCEPTION 'Unsupported billing source' USING ERRCODE='23514';
  END IF;
  -- B001 case writers already lock the case, and case creation locks this lease.
  PERFORM 1 FROM public.esign_cases c WHERE c.org_id=v_org AND c.lease_id=p_lease ORDER BY c.id FOR UPDATE;
  -- Existing legacy signature rows can also be updated directly by staff.
  -- New rows' foreign key checks are fenced by the lease lock above.
  PERFORM 1 FROM public.lease_signatures s WHERE s.org_id=v_org AND s.lease_id=p_lease ORDER BY s.id FOR UPDATE;
  IF v_lease.status NOT IN ('draft','pending_signature') OR v_lease.esign_status NOT IN ('not_sent','sent') OR v_lease.signed_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.lease_signatures s WHERE s.lease_id=p_lease AND s.status='signed')
    OR EXISTS (SELECT 1 FROM public.esign_cases c JOIN public.esign_versions v ON v.case_id=c.id JOIN public.esign_signers s ON s.version_id=v.id WHERE c.org_id=v_org AND c.lease_id=p_lease AND s.signed_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public.esign_cases c JOIN public.esign_versions v ON v.case_id=c.id JOIN public.esign_signature_images i ON i.version_id=v.id WHERE c.org_id=v_org AND c.lease_id=p_lease)
    -- A disposal tombstone does not prove that no partial signature existed.
    OR EXISTS (SELECT 1 FROM public.esign_disposals d WHERE d.org_id=v_org AND d.lease_id=p_lease)
    OR EXISTS (SELECT 1 FROM public.invoices i WHERE i.org_id=v_org AND i.lease_id=p_lease AND i.source='move_in') THEN
    RAISE EXCEPTION 'Billing source is locked' USING ERRCODE='23514';
  END IF;
  v_basis := jsonb_build_object('version','monthly-30-v1','startDate',v_lease.start_date::text,
    'endDate',v_lease.end_date::text,'monthlyRentMinor',v_lease.rent_amount_minor,
    'currency',btrim(v_lease.currency),'rentFrequency',v_lease.rent_frequency::text,
    'prorateFirstPeriod',p_prorate,'actor',v_user::text,'capturedAt',clock_timestamp());
  UPDATE public.leases SET first_period_basis=v_basis,prorate_first_period=p_prorate WHERE id=p_lease AND org_id=v_org;
  RETURN v_basis;
END $function$;

-- app.b017_effective: current definition + pause predicate
CREATE OR REPLACE FUNCTION app.b017_effective(p_org uuid, p_user uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
DECLARE m public.org_members; a app.b017_assignments; keys text[];
BEGIN
 SELECT * INTO m FROM public.org_members WHERE org_id=p_org AND user_id=p_user AND status='active' AND NOT app.b056_member_paused(p_org, p_user);
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF NOT app.b017_enabled(p_org) THEN RETURN app.b017_native(m.role::text); END IF;
 SELECT * INTO a FROM app.b017_assignments WHERE org_id=p_org AND user_id=p_user;
 IF NOT FOUND OR a.role_id IS NULL THEN RETURN app.b017_native(m.role::text); END IF;
 SELECT v.grants INTO keys FROM app.b017_roles r JOIN app.b017_role_revisions v
 ON (v.org_id,v.role_id,v.revision)=(r.org_id,r.id,r.current_revision)
 WHERE r.org_id=p_org AND r.id=a.role_id AND NOT r.retired AND r.current_revision=a.revision;
 RETURN CASE WHEN keys IS NULL THEN NULL ELSE ARRAY(SELECT k FROM unnest(keys) k WHERE k=ANY(app.b017_native(m.role::text))) END;
END $function$;

-- app.b017_invite_guard: current definition + pause predicate
CREATE OR REPLACE FUNCTION app.b017_invite_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
DECLARE ceiling text[];
BEGIN
 IF TG_OP='UPDATE' AND (NEW.org_id,NEW.invited_by) IS DISTINCT FROM (OLD.org_id,OLD.invited_by)
   AND (app.b017_enabled(OLD.org_id) OR app.b017_enabled(NEW.org_id))
 THEN RAISE EXCEPTION 'B017 immutable invitation scope' USING ERRCODE='42501'; END IF;
 IF NEW.kind<>'team_member' OR NEW.status NOT IN ('pending','accepted') OR NOT app.b017_enabled(NEW.org_id) THEN RETURN NEW; END IF;
 -- Existing invite writers may hold the org/invitation already. NOWAIT fences
 -- that inversion; a caller retries the complete operation, never a partial write.
 PERFORM 1 FROM public.platform_settings WHERE key='custom_roles' FOR SHARE NOWAIT;
 PERFORM 1 FROM public.organizations WHERE id=NEW.org_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.org_members WHERE org_id=NEW.org_id ORDER BY (role='admin') DESC,id FOR UPDATE NOWAIT;
 PERFORM 1 FROM app.b017_roles WHERE org_id=NEW.org_id ORDER BY id FOR UPDATE NOWAIT;
 PERFORM 1 FROM app.b017_assignments WHERE org_id=NEW.org_id ORDER BY user_id FOR UPDATE NOWAIT;
 IF NEW.status='pending' AND (auth.uid() IS NULL OR
   (NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=NEW.org_id AND user_id=auth.uid() AND role='admin' AND status='active' AND NOT app.b056_member_paused(org_members.org_id, org_members.user_id))
    OR NOT coalesce(app.b017_effective(NEW.org_id,auth.uid()) @> ARRAY['team.manage'],false)
    OR NOT coalesce(app.b017_native(NEW.role::text) <@ app.b017_effective(NEW.org_id,auth.uid()),false))
)
 THEN RAISE EXCEPTION 'B017 invitation actor ceiling' USING ERRCODE='42501'; END IF;
 ceiling:=app.b017_effective(NEW.org_id,NEW.invited_by);
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=NEW.org_id AND user_id=NEW.invited_by AND role='admin' AND status='active' AND NOT app.b056_member_paused(org_members.org_id, org_members.user_id))
  OR NOT coalesce('team.manage'=ANY(ceiling),false)
  OR NOT coalesce(app.b017_native(NEW.role::text) <@ ceiling,false)
 THEN RAISE EXCEPTION 'B017 invitation grant ceiling' USING ERRCODE='42501'; END IF;
 -- Acceptance runs after the member update, in the same transaction and locks.
 -- Check resulting authority, including any retained assignment, not just role.
 IF NEW.status='accepted' AND (NEW.accepted_by IS NULL OR
   NOT coalesce(app.b017_effective(NEW.org_id,NEW.accepted_by) <@ ceiling,false))
 THEN RAISE EXCEPTION 'B017 retained invitation grant ceiling' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $function$;

-- app.b017_member_guard: current definition + pause predicate
CREATE OR REPLACE FUNCTION app.b017_member_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
DECLARE org uuid; actor uuid:=auth.uid(); ceiling text[];
BEGIN
 org:=CASE WHEN TG_OP='DELETE' THEN OLD.org_id ELSE NEW.org_id END;
 IF TG_OP='UPDATE' AND (NEW.org_id,NEW.user_id) IS DISTINCT FROM (OLD.org_id,OLD.user_id)
   AND (app.b017_enabled(OLD.org_id) OR app.b017_enabled(NEW.org_id))
 THEN RAISE EXCEPTION 'B017 immutable member scope' USING ERRCODE='42501'; END IF;
 IF NOT app.b017_enabled(org) THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' AND OLD.is_billing_owner AND
   (TG_OP='DELETE' OR NOT NEW.is_billing_owner OR NEW.status<>'active' OR NEW.role<>'admin')
 THEN RAISE EXCEPTION 'B017 billing owner protection' USING ERRCODE='42501'; END IF;
 IF actor IS NOT NULL THEN
   ceiling:=app.b017_effective(org,actor);
   IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=org AND user_id=actor AND role='admin' AND status='active' AND NOT app.b056_member_paused(org_members.org_id, org_members.user_id))
     OR NOT coalesce('team.manage'=ANY(ceiling),false)
   THEN RAISE EXCEPTION 'B017 native governance denied' USING ERRCODE='42501'; END IF;
   IF TG_OP<>'DELETE' AND NOT coalesce(app.b017_effective(org,NEW.user_id) <@ ceiling, NEW.status<>'active')
   THEN RAISE EXCEPTION 'B017 native grant ceiling' USING ERRCODE='42501'; END IF;
 END IF;
 PERFORM app.b017_preserve_admin(org);
 RETURN NULL;
END $function$;

-- app.b027_scope: current definition + pause predicate
CREATE OR REPLACE FUNCTION app.b027_scope(p_org uuid, p_admin boolean)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.org_members m
    ON m.org_id=coalesce(o.live_org_id,o.id) AND m.user_id=auth.uid() AND m.status='active' AND NOT app.b056_member_paused(m.org_id, m.user_id)
    WHERE o.id=p_org AND current_setting('app.active_org_id',true)=o.id::text
      AND current_setting('app.env',true)=o.environment::text
      AND ((o.environment='live' AND o.live_org_id IS NULL)
        OR (o.environment='sandbox' AND o.live_org_id IS NOT NULL))
      AND (NOT p_admin OR m.role='admin'));
$function$;

COMMIT;
