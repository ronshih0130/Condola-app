-- B-010 fix-forward (BUILD-ORDER B-010; CEO D3 2026-11-19 12:10 PST). Lands on main the B-010 review-1 blocker
-- fixes and the BLK-MAC-02 Option A guards that were committed on PR #34 (e1ae2b68..50d89c46) as in-place edits to
-- 20261106020000_b010_payment_result_events.sql after #34 reached main at d347374. That file is already applied
-- (main, prod), so it is not edited; this migration moves a database at main's state to #34's final definitions.
-- Stories: CAP-M-35 (proxy-owner confirmation), PLT payment results (B-010 spec). Flag payment_results_v2 stays OFF.
--
-- What changes (each body is 50d89c46's final text unless noted):
--   1. app.b010_payment_confirmations.confirmed_via SET NOT NULL (review-1 #3). Fails closed if a NULL row exists.
--   2. app.b010_confirmations_immutable(): DELETE allowed only for an explicit sandbox reset of a sandbox org.
--   3. NEW app.b010_lock_owner_payment_context(uuid,text,uuid,uuid): owner-collector context lock (owner_direct).
--   4. app.b010_record_confirmation: the 6-argument client-attributed version is DROPPED; the 3-argument version
--      derives confirmed_via / on_behalf from the collector and the authenticated actor (review-1 #1, server-derived).
--   5. app.b010_confirmation_audit: the unpinned (uuid) version is DROPPED; NEW (uuid,uuid,text) pinned to the active
--      org and env (review-1 #3). It keeps the B-056 PR-3a pause predicate on its active-membership test, which the
--      dropped version carried (20261114000000) — the only deviation from 50d89c46's text.
--   6. app.b010_emit_payment_event: dedupe key + source/trigger attribution; owner context may only emit
--      payment_confirmed (review-1 #4).
--   7. NEW app.b010_authorize_owner_payment_confirm(uuid,uuid,text,uuid) (owner_direct authorization) and
--      app.b010_owner_collected_payments(uuid,uuid[]) (service_role only; /m/payments proxy-confirm field).
-- With the flag OFF no request path reaches these functions' writes. No data change, no outbound.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.b010_payment_confirmations WHERE confirmed_via IS NULL) THEN
    RAISE EXCEPTION 'b010 fix-forward: payment confirmations with NULL confirmed_via exist; resolve before applying' USING ERRCODE='23502';
  END IF;
END $$;
ALTER TABLE app.b010_payment_confirmations ALTER COLUMN confirmed_via SET NOT NULL;

CREATE OR REPLACE FUNCTION app.b010_confirmations_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
  -- Only explicit sandbox resets may delete; replica-mode seed wipes skip triggers.
  IF TG_OP='DELETE' THEN
    IF current_setting('app.b010_sandbox_reset',true)='on'
      AND EXISTS (
        SELECT 1 FROM public.organizations o
        WHERE o.id=OLD.org_id AND o.environment='sandbox'
      )
    THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'Payment confirmations are immutable' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION app.b010_confirmations_immutable() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app.b010_lock_owner_payment_context(
  p_org uuid,
  p_environment text,
  p_session uuid,
  p_lease uuid
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_enabled boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id=p_org AND o.environment::text=p_environment
  ) OR NOT EXISTS (
    SELECT 1 FROM public.auth_sessions s
    WHERE s.id=p_session
      AND s.user_id=v_actor
      AND s.revoked_at IS NULL
      AND s.expires_at>clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  PERFORM 1 FROM public.leases l
  WHERE l.id=p_lease AND l.org_id=p_org
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.b010_lease_collectors lc
    JOIN public.contacts c ON c.org_id=p_org AND c.id=lc.owner_contact_id
    WHERE lc.org_id=p_org
      AND lc.lease_id=p_lease
      AND lc.collector='owner'
      AND c.user_id=v_actor
      AND c.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='payment_results_v2' WHERE o.id=p_org AND o.feature_flags->'payment_results_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text))
  INTO v_enabled;
  IF NOT v_enabled THEN
    RETURN false;
  END IF;

  INSERT INTO app.b010_payment_contexts(tx_id,org_id,lease_id,actor_id,session_id,role)
  VALUES(txid_current(),p_org,p_lease,v_actor,p_session,'owner')
  ON CONFLICT(tx_id,org_id,lease_id,actor_id) DO UPDATE
  SET session_id=EXCLUDED.session_id,role=EXCLUDED.role;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.b010_lock_owner_payment_context(uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_lock_owner_payment_context(uuid,text,uuid,uuid) TO authenticated,service_role;

DROP FUNCTION IF EXISTS app.b010_record_confirmation(uuid,text,uuid,text,text,text);

CREATE OR REPLACE FUNCTION app.b010_record_confirmation(
  p_payment uuid,
  p_proxy_owner_confirmed boolean,
  p_source text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_payment public.payments%ROWTYPE;
  v_environment text;
  v_live_org uuid;
  v_collector text;
  v_owner_contact uuid;
  v_staff boolean;
  v_owner boolean;
  v_via text;
  v_on_behalf uuid;
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  SELECT p.* INTO v_payment
  FROM public.payments p
  WHERE p.id=p_payment
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  SELECT o.environment::text, o.live_org_id
  INTO v_environment, v_live_org
  FROM public.organizations o
  WHERE o.id=v_payment.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  -- Called after the domain's submitted -> confirmed UPDATE in the same transaction.
  IF v_payment.status IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'Payment transition unavailable' USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.b010_payment_requirements r
    WHERE r.tx_id=txid_current()
      AND r.payment_id=p_payment
      AND r.kind='payment_confirmed'
      AND r.actor_id=v_actor
  ) THEN
    RAISE EXCEPTION 'Payment transition unavailable' USING ERRCODE='23514';
  END IF;

  IF p_source IS NULL OR p_source !~ '^[a-z_]{1,64}$' THEN
    RAISE EXCEPTION 'Invalid payment confirmation source' USING ERRCODE='22023';
  END IF;

  SELECT lc.collector, lc.owner_contact_id
  INTO v_collector, v_owner_contact
  FROM app.b010_lease_collectors lc
  WHERE lc.org_id=v_payment.org_id AND lc.lease_id=v_payment.lease_id;
  IF NOT FOUND THEN
    v_collector := 'management';
    v_owner_contact := NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM app.b010_payment_contexts ctx
    WHERE ctx.tx_id=txid_current()
      AND ctx.actor_id=v_actor
      AND ctx.org_id=v_payment.org_id
      AND ctx.lease_id=v_payment.lease_id
      AND ctx.role IN ('admin','manager','accountant')
  ) INTO v_staff;

  SELECT EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.org_id=v_payment.org_id
      AND c.id=v_owner_contact
      AND c.user_id=v_actor
      AND c.archived_at IS NULL
  ) INTO v_owner;

  -- Derive attribution from the collector and authenticated actor.
  IF v_collector='management' AND v_staff THEN
    v_via := 'management';
    v_on_behalf := NULL;
  ELSIF v_collector='owner' AND v_owner THEN
    v_via := 'owner_direct';
    v_on_behalf := NULL;
  ELSIF v_collector='owner' AND v_staff AND p_proxy_owner_confirmed IS TRUE THEN
    v_via := 'staff_proxy';
    v_on_behalf := v_owner_contact;
  ELSE
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('b010_confirm:'||p_payment::text,0));

  BEGIN
    INSERT INTO app.b010_payment_confirmations (
      org_id, payment_id, actor_user_id, on_behalf_of_owner_contact_id,
      confirmed_via, source, from_status, to_status
    )
    VALUES (
      v_payment.org_id, p_payment, v_actor, v_on_behalf,
      v_via, p_source, 'submitted', 'confirmed'
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Payment already confirmed' USING ERRCODE='23505';
  END;

  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.b010_record_confirmation(uuid,boolean,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_record_confirmation(uuid,boolean,text) TO authenticated,service_role;

DROP FUNCTION IF EXISTS app.b010_confirmation_audit(uuid);

CREATE OR REPLACE FUNCTION app.b010_confirmation_audit(
  p_payment uuid,
  p_org uuid,
  p_environment text
)
RETURNS TABLE(
  actor_user_id uuid,
  on_behalf_of_owner_contact_id uuid,
  confirmed_via text,
  source text,
  from_status text,
  to_status text,
  created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  -- Pin both authorization paths to the caller's organization and environment.
  RETURN QUERY
    SELECT c.actor_user_id, c.on_behalf_of_owner_contact_id, c.confirmed_via,
      c.source, c.from_status, c.to_status, c.created_at
    FROM app.b010_payment_confirmations c
    JOIN public.payments p ON p.org_id=c.org_id AND p.id=c.payment_id
    JOIN public.organizations o ON o.id=p.org_id
    WHERE p.id=p_payment
      AND p.org_id=p_org
      AND o.id=p_org
      AND o.environment::text=p_environment
      AND p_org::text=current_setting('app.active_org_id',true)
      AND p_environment=current_setting('app.env',true)
      AND (
        EXISTS (
          SELECT 1
          FROM public.org_members m
          WHERE m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
            AND m.user_id=auth.uid()
            AND m.status='active' AND NOT app.b056_member_paused(m.org_id, m.user_id)
            AND m.role IN ('admin','manager','accountant')
        )
        OR EXISTS (
          SELECT 1 FROM public.contacts owner_contact
          WHERE owner_contact.org_id=p_org
            AND owner_contact.user_id=auth.uid()
            AND (
              owner_contact.id=c.on_behalf_of_owner_contact_id
              OR EXISTS (
                SELECT 1 FROM app.b010_lease_collectors lc
                WHERE lc.org_id=p.org_id
                  AND lc.lease_id=p.lease_id
                  AND lc.collector='owner'
                  AND lc.owner_contact_id=owner_contact.id
              )
            )
        )
      );
END $$;
REVOKE ALL ON FUNCTION app.b010_confirmation_audit(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_confirmation_audit(uuid,uuid,text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION app.b010_emit_payment_event(p_payment uuid,p_kind text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE
  v_requirement app.b010_payment_requirements;
  v_event uuid;
  v_dedupe_key text;
BEGIN
  SELECT * INTO v_requirement FROM app.b010_payment_requirements
    WHERE tx_id=txid_current() AND payment_id=p_payment AND kind=p_kind AND actor_id=auth.uid();

  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM app.b010_payment_contexts ctx
    JOIN public.auth_sessions s ON s.id=ctx.session_id AND s.user_id=ctx.actor_id
    WHERE ctx.tx_id=txid_current() AND ctx.org_id=v_requirement.org_id AND ctx.lease_id=v_requirement.lease_id
      AND ctx.actor_id=auth.uid() AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND (ctx.role <> 'owner' OR p_kind='payment_confirmed')) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  v_dedupe_key := 'payment:' || v_requirement.payment_id::text || ':' || v_requirement.kind;

  INSERT INTO app.b010_source_events(
    org_id,lease_id,payment_id,kind,occurrence_key,actor_id,
    dedupe_key,source,triggered_by_user_id
  )
    VALUES(
      v_requirement.org_id,v_requirement.lease_id,v_requirement.payment_id,
      v_requirement.kind,v_requirement.kind,v_requirement.actor_id,
      v_dedupe_key,'payment_result',v_requirement.actor_id
    )
    ON CONFLICT (org_id,dedupe_key) WHERE dedupe_key IS NOT NULL
    DO NOTHING
    RETURNING id INTO v_event;

  IF NOT FOUND THEN
    SELECT e.id INTO v_event
      FROM app.b010_source_events e
      WHERE e.org_id=v_requirement.org_id
        AND e.dedupe_key=v_dedupe_key
        AND e.payment_id=v_requirement.payment_id
        AND e.kind=v_requirement.kind
        AND e.lease_id IS NOT DISTINCT FROM v_requirement.lease_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
    END IF;
  END IF;

  UPDATE app.b010_payment_requirements SET event_id=v_event
    WHERE tx_id=txid_current() AND payment_id=p_payment AND kind=p_kind AND actor_id=auth.uid();

  RETURN v_event;
END $$;

REVOKE ALL ON FUNCTION app.b010_emit_payment_event(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_emit_payment_event(uuid,text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION app.b010_authorize_owner_payment_confirm(
  p_payment uuid,
  p_org uuid,
  p_environment text,
  p_session uuid
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_lease uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id=p_org AND o.environment::text=p_environment
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.organizations o
    JOIN public.platform_settings f ON f.key='payment_results_v2'
    WHERE o.id=p_org
      AND o.feature_flags->'payment_results_v2'='true'::jsonb
      AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array'
      AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
  ) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.contacts c
    JOIN public.property_owners po ON po.org_id=c.org_id AND po.owner_contact_id=c.id
    WHERE c.org_id=p_org
      AND c.user_id=v_actor
      AND c.archived_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.auth_sessions s
    WHERE s.id=p_session
      AND s.user_id=v_actor
      AND s.revoked_at IS NULL
      AND s.expires_at>clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  SELECT p.lease_id INTO v_lease
  FROM public.payments p
  WHERE p.id=p_payment AND p.org_id=p_org;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM 1
  WHERE app.b010_lock_owner_payment_context(p_org,p_environment,p_session,v_lease);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  RETURN v_lease;
END $$;

REVOKE ALL ON FUNCTION app.b010_authorize_owner_payment_confirm(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_authorize_owner_payment_confirm(uuid,uuid,text,uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION app.b010_owner_collected_payments(p_org uuid, p_payment_ids uuid[])
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public,app
AS $$
  SELECT p.id
  FROM public.payments p
  JOIN app.b010_lease_collectors lc
    ON lc.org_id=p.org_id AND lc.lease_id=p.lease_id
  WHERE p.org_id=p_org
    AND p.id=ANY(p_payment_ids)
    AND lc.collector='owner'
$$;

REVOKE ALL ON FUNCTION app.b010_owner_collected_payments(uuid,uuid[])
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_owner_collected_payments(uuid,uuid[])
  TO service_role;

COMMIT;
