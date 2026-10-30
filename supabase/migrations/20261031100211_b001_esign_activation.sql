BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.invoices WHERE source='move_in' AND status <> 'void'
             GROUP BY org_id,lease_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate move-in invoices require review' USING ERRCODE='23514';
  END IF;
END $$;
CREATE UNIQUE INDEX b001_one_live_move_in_invoice ON public.invoices(org_id,lease_id)
  WHERE source='move_in' AND status <> 'void';

-- This table is written only by the migration owner through its trigger.
-- It remembers eligibility before activation for the deferred check.
CREATE TABLE app.b001_completion_requirements (
  version_id uuid PRIMARY KEY,
  case_id uuid NOT NULL,
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  case_creator_id uuid NOT NULL,
  previous_status text NOT NULL CHECK (previous_status IN ('draft','pending_signature'))
);
REVOKE ALL ON app.b001_completion_requirements FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b001_lock_parent_before_case() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_case uuid; v_lease uuid;
BEGIN
  IF TG_TABLE_NAME='esign_cases' THEN
    v_lease := CASE WHEN TG_OP='DELETE' THEN OLD.lease_id ELSE NEW.lease_id END;
  ELSIF TG_TABLE_NAME='esign_versions' THEN
    v_case := CASE WHEN TG_OP='DELETE' THEN OLD.case_id ELSE NEW.case_id END;
  ELSIF TG_TABLE_NAME='esign_audit_events' THEN
    v_case := CASE WHEN TG_OP='DELETE' THEN OLD.case_id ELSE NEW.case_id END;
  ELSE
    SELECT case_id INTO v_case FROM public.esign_versions
     WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  END IF;
  IF v_lease IS NULL THEN
    SELECT lease_id INTO v_lease FROM public.esign_cases WHERE id=v_case;
  END IF;
  IF v_lease IS NULL THEN RAISE EXCEPTION 'Signing case unavailable' USING ERRCODE='23503'; END IF;
  -- NOWAIT is required because UPDATE/DELETE already owns the child tuple.
  PERFORM 1 FROM public.leases WHERE id=v_lease FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Signing lease unavailable' USING ERRCODE='23503'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b001_lock_parent_before_case() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER a_b001_parent_before_case BEFORE INSERT OR UPDATE OR DELETE ON public.esign_cases FOR EACH ROW EXECUTE FUNCTION app.b001_lock_parent_before_case();
CREATE TRIGGER a_b001_parent_before_version BEFORE INSERT OR UPDATE OR DELETE ON public.esign_versions FOR EACH ROW EXECUTE FUNCTION app.b001_lock_parent_before_case();
CREATE TRIGGER a_b001_parent_before_signer BEFORE INSERT OR UPDATE OR DELETE ON public.esign_signers FOR EACH ROW EXECUTE FUNCTION app.b001_lock_parent_before_case();
CREATE TRIGGER a_b001_parent_before_image BEFORE INSERT OR UPDATE OR DELETE ON public.esign_signature_images FOR EACH ROW EXECUTE FUNCTION app.b001_lock_parent_before_case();
CREATE TRIGGER a_b001_parent_before_audit BEFORE INSERT OR UPDATE OR DELETE ON public.esign_audit_events FOR EACH ROW EXECUTE FUNCTION app.b001_lock_parent_before_case();

CREATE FUNCTION app.b001_record_completion_requirement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_case public.esign_cases; v_lease public.leases; v_actor uuid := auth.uid();
BEGIN
  IF OLD.status='fully_signed' OR NEW.status <> 'fully_signed' THEN RETURN NEW; END IF;
  SELECT * INTO STRICT v_case FROM public.esign_cases WHERE id=NEW.case_id;
  SELECT * INTO STRICT v_lease FROM public.leases WHERE id=v_case.lease_id AND org_id=v_case.org_id;
  IF v_lease.status IN ('draft','pending_signature') AND v_lease.esign_status <> 'imported' THEN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'Signing actor required' USING ERRCODE='42501'; END IF;
    INSERT INTO app.b001_completion_requirements(version_id,case_id,org_id,lease_id,actor_id,case_creator_id,previous_status)
      VALUES(NEW.id,v_case.id,v_case.org_id,v_case.lease_id,v_actor,v_case.created_by,v_lease.status::text);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b001_record_completion_requirement() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b001_record_completion AFTER UPDATE ON public.esign_versions FOR EACH ROW EXECUTE FUNCTION app.b001_record_completion_requirement();

CREATE FUNCTION app.b001_require_completion_financials() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.leases l JOIN public.invoices i ON i.org_id=l.org_id AND i.lease_id=l.id
    JOIN public.ledger_transactions t ON t.id=i.ledger_transaction_id AND t.org_id=i.org_id
    WHERE l.id=NEW.lease_id AND l.org_id=NEW.org_id AND l.status='active'
      AND i.source='move_in' AND i.status <> 'void' AND t.source_table='invoices' AND t.source_id=i.id
      AND EXISTS (SELECT 1 FROM public.ledger_entries e WHERE e.transaction_id=t.id AND e.invoice_id=i.id AND e.account='tenant_receivable')
      AND (NOT EXISTS (SELECT 1 FROM public.invoice_lines il WHERE il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor > 0)
        OR EXISTS (SELECT 1 FROM public.ledger_entries e WHERE e.transaction_id=t.id AND e.invoice_id=i.id AND e.account='rental_income'))
      AND EXISTS (SELECT 1 FROM public.audit_log a WHERE a.org_id=NEW.org_id AND a.actor_user_id=NEW.actor_id AND a.event_type='esign_lease_activated'
        AND a.table_name='leases' AND a.row_id=l.id::text AND a.new_row->>'invoice_id'=i.id::text
        AND a.new_row->>'case_id'=NEW.case_id::text AND a.new_row->>'version_id'=NEW.version_id::text
        AND a.new_row->>'case_creator_id'=NEW.case_creator_id::text)
  ) THEN RAISE EXCEPTION 'Signing completion requires activation and first invoice' USING ERRCODE='23514'; END IF;
  -- A transaction guard is not a retention record. The existing audit trail is durable.
  DELETE FROM app.b001_completion_requirements WHERE version_id=NEW.version_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.b001_require_completion_financials() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER b001_completion_financials AFTER INSERT ON app.b001_completion_requirements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b001_require_completion_financials();
COMMIT;
