BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS app.b010_lease_collectors (
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  collector text NOT NULL DEFAULT 'management' CHECK (collector IN ('management','owner')),
  owner_contact_id uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY(org_id,lease_id),
  FOREIGN KEY(org_id,lease_id) REFERENCES public.leases(org_id,id),
  FOREIGN KEY(org_id,owner_contact_id) REFERENCES public.contacts(org_id,id),
  CHECK (collector <> 'owner' OR owner_contact_id IS NOT NULL)
);

ALTER TABLE app.b010_lease_collectors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b010_lease_collectors FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE IF NOT EXISTS app.b010_payment_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  on_behalf_of_owner_contact_id uuid,
  confirmed_via text NOT NULL CHECK (confirmed_via IN ('owner_direct','staff_proxy','management')),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  from_status text NOT NULL,
  to_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT b010_payment_confirmations_one_per_payment UNIQUE(org_id,payment_id),
  FOREIGN KEY(org_id,payment_id) REFERENCES public.payments(org_id,id),
  CHECK ((confirmed_via = 'staff_proxy' AND on_behalf_of_owner_contact_id IS NOT NULL) OR
    (confirmed_via IN ('owner_direct','management') AND on_behalf_of_owner_contact_id IS NULL))
);

ALTER TABLE app.b010_payment_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b010_payment_confirmations FROM PUBLIC,anon,authenticated,service_role;

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

DROP TRIGGER IF EXISTS b010_payment_confirmations_no_change ON app.b010_payment_confirmations;
CREATE TRIGGER b010_payment_confirmations_no_change BEFORE UPDATE OR DELETE ON app.b010_payment_confirmations
FOR EACH ROW EXECUTE FUNCTION app.b010_confirmations_immutable();
DROP TRIGGER IF EXISTS b010_payment_confirmations_no_truncate ON app.b010_payment_confirmations;
CREATE TRIGGER b010_payment_confirmations_no_truncate BEFORE TRUNCATE ON app.b010_payment_confirmations
FOR EACH STATEMENT EXECUTE FUNCTION app.b010_confirmations_immutable();

ALTER TABLE app.b010_source_events
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS triggered_by_user_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS b010_source_events_dedupe_uq
  ON app.b010_source_events(org_id,dedupe_key) WHERE dedupe_key IS NOT NULL;

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

CREATE OR REPLACE FUNCTION app.b010_payment_collector(p_payment uuid)
RETURNS TABLE(collector text, owner_contact_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_lease uuid;
BEGIN
  SELECT p.org_id, p.lease_id INTO v_org, v_lease
  FROM public.payments p
  WHERE p.id=p_payment
    AND EXISTS (
      SELECT 1 FROM app.b010_payment_contexts ctx
      WHERE ctx.tx_id=txid_current()
        AND ctx.actor_id=v_actor
        AND ctx.org_id=p.org_id
        AND ctx.lease_id=p.lease_id
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  RETURN QUERY
    SELECT lc.collector, lc.owner_contact_id
    FROM app.b010_lease_collectors lc
    WHERE lc.org_id=v_org AND lc.lease_id=v_lease;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'management'::text, NULL::uuid;
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.b010_payment_collector(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_payment_collector(uuid) TO authenticated,service_role;

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
      AND (
        EXISTS (
          SELECT 1
          FROM public.org_members m
          WHERE m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
            AND m.user_id=auth.uid()
            AND m.status='active'
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

COMMIT;
