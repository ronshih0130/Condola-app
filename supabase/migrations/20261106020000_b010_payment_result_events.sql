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
  confirmed_via text CHECK (confirmed_via IN ('owner_direct','staff_proxy','management')),
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

CREATE OR REPLACE FUNCTION app.b010_record_confirmation(
  p_payment uuid,
  p_via text,
  p_on_behalf uuid,
  p_source text,
  p_from text,
  p_to text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_lease uuid;
  v_id uuid;
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

  IF p_via='staff_proxy' AND NOT EXISTS (
    SELECT 1 FROM app.b010_lease_collectors lc
    WHERE lc.org_id=v_org AND lc.lease_id=v_lease
      AND lc.collector='owner'
      AND lc.owner_contact_id=p_on_behalf
  ) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('b010_confirm:'||p_payment::text,0));

  BEGIN
    INSERT INTO app.b010_payment_confirmations (
      org_id, payment_id, actor_user_id, on_behalf_of_owner_contact_id,
      confirmed_via, source, from_status, to_status
    )
    VALUES (
      v_org, p_payment, v_actor, p_on_behalf,
      p_via, p_source, p_from, p_to
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Payment already confirmed' USING ERRCODE='23505';
  END;

  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.b010_record_confirmation(uuid,text,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_record_confirmation(uuid,text,uuid,text,text,text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION app.b010_confirmation_audit(p_payment uuid)
RETURNS TABLE(
  actor_user_id uuid,
  on_behalf_of_owner_contact_id uuid,
  confirmed_via text,
  source text,
  from_status text,
  to_status text,
  created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
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
          AND m.status='active'
      )
      OR EXISTS (
        SELECT 1 FROM public.contacts owner_contact
        WHERE owner_contact.org_id=c.org_id
          AND owner_contact.id=c.on_behalf_of_owner_contact_id
          AND owner_contact.user_id=auth.uid()
      )
    );
$$;
REVOKE ALL ON FUNCTION app.b010_confirmation_audit(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_confirmation_audit(uuid) TO authenticated,service_role;

COMMIT;
