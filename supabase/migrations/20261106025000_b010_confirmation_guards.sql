-- Stack-tip QA fixes for B-010 (Mac Claude overnight 2026-11-06, Codex cross-audit).
-- 1. b010_record_confirmation: provenance must match a real submitted->confirmed
--    transition by the same actor in this transaction, and confirmed_via must be
--    consistent with the lease collector (owner_direct only for the collector
--    owner's own user; management only when the collector is not the owner).
-- 2. b010_confirmation_audit: staff branch uses app.is_member so the pinned
--    organization/environment scope (PROP-02) applies; sandbox audits are not
--    readable from a live-pinned session.
-- 3. Private transaction-scoped transition evidence (trigger on payments status,
--    context-gated so flag OFF writes nothing; cleared at commit).
-- payment_results_v2 stays OFF; no grant or flag change.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Transaction-scoped evidence of a real submitted->confirmed status change.
-- Written only when a B-010 payment context exists for this transaction
-- (payment_results_v2 ON), so flag OFF adds no rows. Rows are removed at commit.
CREATE TABLE IF NOT EXISTS app.b010_confirm_transitions (
  tx_id bigint NOT NULL,
  org_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  PRIMARY KEY (tx_id, payment_id)
);
ALTER TABLE app.b010_confirm_transitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b010_confirm_transitions FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app.b010_note_confirm_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF OLD.status='submitted' AND NEW.status='confirmed' AND auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.b010_payment_contexts ctx
    WHERE ctx.tx_id=txid_current() AND ctx.org_id=NEW.org_id
      AND ctx.lease_id=NEW.lease_id AND ctx.actor_id=auth.uid()
  ) THEN
    INSERT INTO app.b010_confirm_transitions(tx_id,org_id,payment_id,actor_id)
    VALUES (txid_current(),NEW.org_id,NEW.id,auth.uid())
    ON CONFLICT (tx_id,payment_id) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.b010_note_confirm_transition() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS b010_note_confirm_transition ON public.payments;
CREATE TRIGGER b010_note_confirm_transition AFTER UPDATE OF status ON public.payments
FOR EACH ROW EXECUTE FUNCTION app.b010_note_confirm_transition();

CREATE OR REPLACE FUNCTION app.b010_clean_confirm_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
  DELETE FROM app.b010_confirm_transitions WHERE tx_id=NEW.tx_id AND payment_id=NEW.payment_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.b010_clean_confirm_transition() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS b010_confirm_transition_cleanup ON app.b010_confirm_transitions;
CREATE CONSTRAINT TRIGGER b010_confirm_transition_cleanup AFTER INSERT ON app.b010_confirm_transitions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b010_clean_confirm_transition();

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
  v_status text;
  v_confirmed_by uuid;
  v_collector text;
  v_owner uuid;
  v_id uuid;
BEGIN
  SELECT p.org_id, p.lease_id, p.status::text, p.confirmed_by
    INTO v_org, v_lease, v_status, v_confirmed_by
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

  -- Only a real submitted->confirmed change this actor made in this
  -- transaction (trigger evidence) may be recorded; metadata-only edits fail.
  IF p_from IS DISTINCT FROM 'submitted' OR p_to IS DISTINCT FROM 'confirmed'
     OR v_status IS DISTINCT FROM 'confirmed'
     OR v_confirmed_by IS DISTINCT FROM v_actor
     OR NOT EXISTS (
       SELECT 1 FROM app.b010_confirm_transitions ev
       WHERE ev.tx_id=txid_current() AND ev.payment_id=p_payment
         AND ev.org_id=v_org AND ev.actor_id=v_actor
     ) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;

  SELECT lc.collector, lc.owner_contact_id INTO v_collector, v_owner
  FROM app.b010_lease_collectors lc
  WHERE lc.org_id=v_org AND lc.lease_id=v_lease;
  v_collector := coalesce(v_collector, 'management');

  IF p_via='staff_proxy' THEN
    IF v_collector <> 'owner' OR p_on_behalf IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
    END IF;
  ELSIF p_via='owner_direct' THEN
    IF v_collector <> 'owner' OR p_on_behalf IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM public.contacts oc
      WHERE oc.org_id=v_org AND oc.id=v_owner AND oc.user_id=v_actor
    ) THEN
      RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
    END IF;
  ELSIF p_via='management' THEN
    IF v_collector <> 'management' OR p_on_behalf IS NOT NULL THEN
      RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
    END IF;
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
      app.is_member(p.org_id)
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
