BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Seal bytes must never enter member-readable profile snapshots. This migration
-- has only been rehearsed locally: rebuild that DB rather than carrying forward
-- the rejected local base64 snapshots. The validated CHECK fails closed if any
-- such row is present; it does not copy bytes into public rows or rewrite history.
CREATE TABLE app.b025_profile_seals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  vendor_profile_id uuid NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 5242880),
  sha256 text NOT NULL CHECK (sha256 = encode(sha256(bytes),'hex')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (org_id,vendor_profile_id) REFERENCES public.vendor_profiles(org_id,id)
);
ALTER TABLE app.b025_profile_seals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b025_profile_seals FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b025_seals_no_change BEFORE UPDATE OR DELETE ON app.b025_profile_seals
FOR EACH ROW EXECUTE FUNCTION app.b025_history_immutable();
CREATE TRIGGER b025_seals_no_truncate BEFORE TRUNCATE ON app.b025_profile_seals
FOR EACH STATEMENT EXECUTE FUNCTION app.b025_history_immutable();

ALTER TABLE public.vendor_profile_versions ADD CONSTRAINT b025_seal_reference_only CHECK (
  NOT (snapshot ? 'seal') OR (
    jsonb_typeof(snapshot->'seal') = 'object'
    AND snapshot->'seal' ?& ARRAY['id','sha256']
    AND ((snapshot->'seal') - 'id' - 'sha256') = '{}'::jsonb
    AND jsonb_typeof(snapshot->'seal'->'id') = 'string'
    AND (snapshot->'seal'->>'id') ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    AND jsonb_typeof(snapshot->'seal'->'sha256') = 'string'
    AND (snapshot->'seal'->>'sha256') ~ '^[0-9a-f]{64}$'
  ) IS TRUE
);

-- Service-only gateways receive an already authenticated token capability.
-- Grant IDs in member-readable metadata are never accepted from SQL API roles.
CREATE FUNCTION app.b025_seal_scope(p_org uuid,p_grant uuid,p_profile uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  PERFORM 1 FROM public.platform_settings WHERE key='vendor_documents' FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE;
  PERFORM 1 FROM public.vendor_document_grants WHERE id=p_grant AND org_id=p_org
    AND vendor_profile_id=p_profile AND scope='vendor_document'
    AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND OR NOT app.b025_flag_on(p_org) THEN
    RAISE EXCEPTION 'document unavailable' USING ERRCODE='42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.b025_seal_scope(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b025_store_profile_seal(p_org uuid,p_grant uuid,p_profile uuid,p_mime text,p_bytes bytea)
RETURNS TABLE(id uuid,sha256 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  PERFORM app.b025_seal_scope(p_org,p_grant,p_profile);
  RETURN QUERY INSERT INTO app.b025_profile_seals AS s(org_id,vendor_profile_id,mime_type,bytes,sha256)
    VALUES(p_org,p_profile,p_mime,p_bytes,encode(sha256(p_bytes),'hex')) RETURNING s.id,s.sha256;
END $$;
REVOKE ALL ON FUNCTION app.b025_store_profile_seal(uuid,uuid,uuid,text,bytea) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b025_store_profile_seal(uuid,uuid,uuid,text,bytea) TO service_role;

CREATE FUNCTION app.b025_read_profile_seal(p_org uuid,p_grant uuid,p_profile uuid,p_version integer)
RETURNS TABLE(bytes bytea,mime_type text,sha256 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  PERFORM app.b025_seal_scope(p_org,p_grant,p_profile);
  RETURN QUERY SELECT s.bytes,s.mime_type,s.sha256 FROM public.vendor_profile_versions v
    JOIN app.b025_profile_seals s ON s.id=(v.snapshot->'seal'->>'id')::uuid
      AND s.sha256=v.snapshot->'seal'->>'sha256'
      AND s.org_id=v.org_id AND s.vendor_profile_id=v.vendor_profile_id
    WHERE v.org_id=p_org AND v.vendor_profile_id=p_profile AND v.version=p_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'document unavailable' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b025_read_profile_seal(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b025_read_profile_seal(uuid,uuid,uuid,integer) TO service_role;

-- Legacy object-backed seals use the same admission before server-side fetch.
-- The reference is taken from the selected immutable version, not live profile data.
CREATE FUNCTION app.b025_legacy_seal_path(p_org uuid,p_grant uuid,p_profile uuid,p_version integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE path text;
BEGIN
  PERFORM app.b025_seal_scope(p_org,p_grant,p_profile);
  SELECT f.storage_path INTO path FROM public.vendor_profile_versions v
    JOIN public.files f ON f.id=v.seal_file_id AND f.org_id=v.org_id
    WHERE v.org_id=p_org AND v.vendor_profile_id=p_profile AND v.version=p_version
      AND v.kind='business' AND NOT (v.snapshot ? 'seal')
      AND f.storage_bucket='ticket-photos-private' AND f.size_bytes BETWEEN 1 AND 5242880
    FOR SHARE OF f;
  IF NOT FOUND THEN RAISE EXCEPTION 'document unavailable' USING ERRCODE='42501'; END IF;
  RETURN path;
END $$;
REVOKE ALL ON FUNCTION app.b025_legacy_seal_path(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b025_legacy_seal_path(uuid,uuid,uuid,integer) TO service_role;

-- Existing profile versions and PDF bytes already hold immutable snapshots.
-- Also freeze their references and validate scope on new document links.
CREATE FUNCTION app.b025_snapshot_reference_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.vendor_profile_version_id IS DISTINCT FROM OLD.vendor_profile_version_id
    OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256 OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.reissued_from IS DISTINCT FROM OLD.reissued_from
    OR NEW.id IS DISTINCT FROM OLD.id) THEN
    RAISE EXCEPTION 'immutable vendor snapshot reference' USING ERRCODE='55000';
  END IF;
  IF NEW.vendor_profile_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.vendor_profile_versions v WHERE v.id=NEW.vendor_profile_version_id
      AND v.org_id=NEW.org_id AND v.vendor_profile_id=NEW.vendor_profile_id
  ) THEN RAISE EXCEPTION 'invalid snapshot scope' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b025_snapshot_reference_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b025_snapshot_reference_guard BEFORE INSERT OR UPDATE ON public.vendor_documents
FOR EACH ROW EXECUTE FUNCTION app.b025_snapshot_reference_guard();

-- A group is the root electronic receipt and all its reissues. Scans are
-- independent siblings, never vendor_documents rows or charge/payment rows.
CREATE TABLE app.b025_paper_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  document_group_id uuid NOT NULL REFERENCES public.vendor_documents(id),
  document_id uuid NOT NULL REFERENCES public.vendor_documents(id),
  grant_id uuid NOT NULL REFERENCES public.vendor_document_grants(id),
  request_id uuid NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','application/pdf')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 5242880),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,request_id)
);
CREATE INDEX b025_paper_scans_group ON app.b025_paper_scans(org_id,document_group_id);
ALTER TABLE app.b025_paper_scans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b025_paper_scans FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b025_scans_no_change BEFORE UPDATE OR DELETE ON app.b025_paper_scans
FOR EACH ROW EXECUTE FUNCTION app.b025_history_immutable();
CREATE TRIGGER b025_scans_no_truncate BEFORE TRUNCATE ON app.b025_paper_scans
FOR EACH STATEMENT EXECUTE FUNCTION app.b025_history_immutable();

-- Invoked only by the server after token admission. Recheck scope/expiry/flags
-- inside each gateway too; caller-supplied org or document IDs grant no access.
CREATE FUNCTION app.b025_document_group(p_org uuid,p_grant uuid,p_document uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE g public.vendor_document_grants%ROWTYPE; d public.vendor_documents%ROWTYPE; root uuid;
BEGIN
  PERFORM 1 FROM public.platform_settings WHERE key='vendor_documents' FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE;
  SELECT * INTO g FROM public.vendor_document_grants WHERE id=p_grant AND org_id=p_org
    AND scope='vendor_document' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND OR NOT app.b025_flag_on(p_org) THEN
    RAISE EXCEPTION 'document unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO d FROM public.vendor_documents WHERE id=p_document AND org_id=p_org
    AND ticket_id=g.ticket_id AND vendor_profile_id=g.vendor_profile_id AND kind='receipt';
  IF NOT FOUND THEN RAISE EXCEPTION 'document unavailable' USING ERRCODE='42501'; END IF;
  WITH RECURSIVE chain AS (
    SELECT id,reissued_from FROM public.vendor_documents WHERE id=d.id
    UNION
    SELECT parent.id,parent.reissued_from FROM public.vendor_documents parent JOIN chain c ON parent.id=c.reissued_from
      WHERE parent.org_id=p_org AND parent.ticket_id=g.ticket_id
        AND parent.vendor_profile_id=g.vendor_profile_id AND parent.kind='receipt'
  ) SELECT id INTO root FROM chain WHERE reissued_from IS NULL;
  IF root IS NULL THEN RAISE EXCEPTION 'document unavailable' USING ERRCODE='42501'; END IF;
  RETURN root;
END $$;
REVOKE ALL ON FUNCTION app.b025_document_group(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b025_attach_paper_scan(p_org uuid,p_grant uuid,p_document uuid,p_request uuid,p_mime text,p_bytes bytea)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE root uuid; existing app.b025_paper_scans%ROWTYPE; hash text;
BEGIN
  root := app.b025_document_group(p_org,p_grant,p_document);
  IF p_request IS NULL OR p_bytes IS NULL OR octet_length(p_bytes) NOT BETWEEN 1 AND 5242880
    OR p_mime IS NULL OR p_mime NOT IN ('image/png','image/jpeg','application/pdf') THEN
    RAISE EXCEPTION 'invalid scan' USING ERRCODE='23514';
  END IF;
  hash := encode(sha256(p_bytes),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('b025-scan:'||p_org::text||':'||p_request::text,0));
  SELECT * INTO existing FROM app.b025_paper_scans WHERE org_id=p_org AND request_id=p_request;
  IF FOUND THEN
    IF existing.document_id<>p_document OR existing.grant_id<>p_grant OR existing.sha256<>hash OR existing.mime_type<>p_mime THEN
      RAISE EXCEPTION 'scan request conflict' USING ERRCODE='42501';
    END IF;
    RETURN existing.id;
  END IF;
  INSERT INTO app.b025_paper_scans(org_id,document_group_id,document_id,grant_id,request_id,mime_type,bytes,sha256)
    VALUES(p_org,root,p_document,p_grant,p_request,p_mime,p_bytes,hash) RETURNING id INTO existing.id;
  RETURN existing.id;
END $$;
REVOKE ALL ON FUNCTION app.b025_attach_paper_scan(uuid,uuid,uuid,uuid,text,bytea) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b025_attach_paper_scan(uuid,uuid,uuid,uuid,text,bytea) TO service_role;

CREATE FUNCTION app.b025_paper_scan_history(p_org uuid,p_grant uuid,p_document uuid)
RETURNS TABLE(id uuid,document_group_id uuid,document_id uuid,mime_type text,sha256 text,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE root uuid;
BEGIN
  root := app.b025_document_group(p_org,p_grant,p_document);
  RETURN QUERY SELECT s.id,s.document_group_id,s.document_id,s.mime_type,s.sha256,s.created_at
    FROM app.b025_paper_scans s WHERE s.org_id=p_org AND s.document_group_id=root ORDER BY s.created_at,s.id;
END $$;
REVOKE ALL ON FUNCTION app.b025_paper_scan_history(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b025_paper_scan_history(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION app.b025_read_paper_scan(p_org uuid,p_grant uuid,p_scan uuid)
RETURNS TABLE(bytes bytea,mime_type text,sha256 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE s app.b025_paper_scans%ROWTYPE;
BEGIN
  SELECT * INTO s FROM app.b025_paper_scans WHERE id=p_scan AND org_id=p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'document unavailable' USING ERRCODE='42501'; END IF;
  PERFORM app.b025_document_group(p_org,p_grant,s.document_id);
  RETURN QUERY SELECT s.bytes,s.mime_type,s.sha256;
END $$;
REVOKE ALL ON FUNCTION app.b025_read_paper_scan(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b025_read_paper_scan(uuid,uuid,uuid) TO service_role;
COMMIT;
