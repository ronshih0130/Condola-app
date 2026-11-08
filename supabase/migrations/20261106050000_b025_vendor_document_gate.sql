BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO public.platform_settings(key,value)
VALUES ('vendor_documents','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.b025_received_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  ticket_id uuid NOT NULL,
  vendor_profile_id uuid NOT NULL,
  grant_id uuid NOT NULL REFERENCES public.vendor_document_grants(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,request_id),
  FOREIGN KEY(org_id,ticket_id) REFERENCES public.maintenance_tickets(org_id,id),
  FOREIGN KEY(org_id,vendor_profile_id) REFERENCES public.vendor_profiles(org_id,id)
);
CREATE INDEX b025_received_scope ON app.b025_received_marks(org_id,ticket_id,vendor_profile_id);
ALTER TABLE app.b025_received_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b025_received_marks FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b025_history_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  RAISE EXCEPTION 'Vendor received history is immutable' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION app.b025_history_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b025_received_no_change BEFORE UPDATE OR DELETE ON app.b025_received_marks
FOR EACH ROW EXECUTE FUNCTION app.b025_history_immutable();
CREATE TRIGGER b025_received_no_truncate BEFORE TRUNCATE ON app.b025_received_marks
FOR EACH STATEMENT EXECUTE FUNCTION app.b025_history_immutable();

CREATE FUNCTION app.b025_flag_on(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_settings f JOIN public.organizations o ON o.id=p_org
    WHERE f.key='vendor_documents' AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array'
      AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
      AND o.feature_flags->'vendor_documents'='true'::jsonb
  );
$$;
REVOKE ALL ON FUNCTION app.b025_flag_on(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b025_receipt_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF NEW.kind='receipt' AND app.b025_flag_on(NEW.org_id) AND
    (SELECT coalesce(sum(m.amount_minor),0) FROM app.b025_received_marks m
      WHERE m.org_id=NEW.org_id AND m.ticket_id=NEW.ticket_id
        AND m.vendor_profile_id=NEW.vendor_profile_id) < NEW.total_minor THEN
    RAISE EXCEPTION 'receipt_requires_full_payment'
      USING ERRCODE='23514', CONSTRAINT='b025_receipt_requires_full_payment';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b025_receipt_gate() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b025_receipt_full_payment BEFORE INSERT ON public.vendor_documents
FOR EACH ROW EXECUTE FUNCTION app.b025_receipt_gate();

-- Issued documents are immutable apart from voiding: identity and financial fields can
-- never change after insert, so the full-payment gate cannot be bypassed by turning a
-- completion statement into a receipt (or by editing totals/items) with UPDATE.
CREATE FUNCTION app.b025_document_identity_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.items IS DISTINCT FROM OLD.items OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id
     OR NEW.vendor_profile_id IS DISTINCT FROM OLD.vendor_profile_id OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.doc_no IS DISTINCT FROM OLD.doc_no OR NEW.buyer IS DISTINCT FROM OLD.buyer THEN
    RAISE EXCEPTION 'vendor_document_identity_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b025_document_identity_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b025_document_identity_immutable BEFORE UPDATE ON public.vendor_documents
FOR EACH ROW EXECUTE FUNCTION app.b025_document_identity_immutable();

CREATE FUNCTION app.b025_record_received(p_org uuid,p_grant uuid,p_request uuid,p_amount bigint)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE g public.vendor_document_grants%ROWTYPE; m app.b025_received_marks%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.platform_settings WHERE key='vendor_documents' FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE;
  IF NOT app.b025_flag_on(p_org) OR p_request IS NULL OR p_amount IS NULL OR p_amount<=0 THEN
    RAISE EXCEPTION 'Vendor document unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO g FROM public.vendor_document_grants
    WHERE id=p_grant AND org_id=p_org AND scope='vendor_document'
      AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor document unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('b025:'||p_org::text||':'||p_request::text,0));
  SELECT * INTO m FROM app.b025_received_marks WHERE org_id=p_org AND request_id=p_request;
  IF FOUND THEN
    IF m.grant_id<>p_grant OR m.amount_minor<>p_amount THEN
      RAISE EXCEPTION 'Received request conflict' USING ERRCODE='42501';
    END IF;
    RETURN m.id;
  END IF;
  INSERT INTO app.b025_received_marks(org_id,ticket_id,vendor_profile_id,grant_id,request_id,amount_minor)
    VALUES(p_org,g.ticket_id,g.vendor_profile_id,g.id,p_request,p_amount) RETURNING id INTO m.id;
  RETURN m.id;
END $$;
REVOKE ALL ON FUNCTION app.b025_record_received(uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b025_record_received(uuid,uuid,uuid,bigint) TO service_role;

-- The service role has no raw table access. Reads are scoped to a live grant,
-- including marks from replaced invitations for the same work order and issuer.
CREATE FUNCTION app.b025_received_summary(p_org uuid,p_grant uuid)
RETURNS TABLE(amount_minor text,created_at text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE g public.vendor_document_grants%ROWTYPE;
BEGIN
  SELECT * INTO g FROM public.vendor_document_grants
    WHERE id=p_grant AND org_id=p_org AND scope='vendor_document'
      AND revoked_at IS NULL AND expires_at>clock_timestamp();
  IF NOT FOUND OR NOT app.b025_flag_on(p_org) THEN
    RAISE EXCEPTION 'Vendor document unavailable' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT m.amount_minor::text,m.created_at::text FROM app.b025_received_marks m
    WHERE m.org_id=p_org AND m.ticket_id=g.ticket_id AND m.vendor_profile_id=g.vendor_profile_id
    ORDER BY m.created_at,m.id;
END $$;
REVOKE ALL ON FUNCTION app.b025_received_summary(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b025_received_summary(uuid,uuid) TO service_role;
COMMIT;
