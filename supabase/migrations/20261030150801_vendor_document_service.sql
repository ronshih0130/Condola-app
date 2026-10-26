-- Version 20261030150801.
-- Transactional PDF persistence and independent document-operation grants.
-- No storage buckets are created.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.vendor_document_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  ticket_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.repair_vendor_jobs(id),
  vendor_profile_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scope text NOT NULL DEFAULT 'vendor_document' CHECK (scope = 'vendor_document'),
  buyer_selection jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, ticket_id)
    REFERENCES public.maintenance_tickets(org_id, id),
  FOREIGN KEY (org_id, vendor_profile_id)
    REFERENCES public.vendor_profiles(org_id, id)
);

-- The document ID is the durable bytes reference. Keeping bytes in PostgreSQL
-- makes allocation, snapshots, rendering and persistence one atomic commit.
CREATE TABLE IF NOT EXISTS public.vendor_document_pdf_bytes (
  document_id uuid PRIMARY KEY REFERENCES public.vendor_documents(id),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  bytes bytea NOT NULL CHECK (octet_length(bytes) > 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vendor_document_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_document_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_document_pdf_bytes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_document_pdf_bytes FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vendor_document_grants,
  public.vendor_document_pdf_bytes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.vendor_document_grants TO service_role;
GRANT SELECT, INSERT
  ON TABLE public.vendor_document_pdf_bytes TO service_role;

-- svc()/svcOn() SET LOCAL ROLE service_role. BYPASSRLS does not grant table
-- privileges. Reassert the 150800 privileges used by onboarding and documents.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.job_types,
  public.vendor_profiles,
  public.vendor_profile_versions,
  public.vendor_onboarding_invites,
  public.vendor_document_sequences,
  public.vendor_documents
TO service_role;
GRANT EXECUTE ON FUNCTION app.next_vendor_document_seq(uuid) TO service_role;

-- Bytes and operation grants are service-only. Authorized reads pass through
-- the service and revalidate their session or scoped token.
CREATE OR REPLACE FUNCTION app.reject_vendor_snapshot_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'immutable vendor snapshot' USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION app.reject_vendor_snapshot_change()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.reject_vendor_snapshot_change() TO service_role;

DROP TRIGGER IF EXISTS vendor_profile_versions_immutable
  ON public.vendor_profile_versions;
CREATE TRIGGER vendor_profile_versions_immutable
BEFORE UPDATE OR DELETE ON public.vendor_profile_versions
FOR EACH ROW EXECUTE FUNCTION app.reject_vendor_snapshot_change();

DROP TRIGGER IF EXISTS vendor_document_pdf_bytes_immutable
  ON public.vendor_document_pdf_bytes;
CREATE TRIGGER vendor_document_pdf_bytes_immutable
BEFORE UPDATE OR DELETE ON public.vendor_document_pdf_bytes
FOR EACH ROW EXECUTE FUNCTION app.reject_vendor_snapshot_change();

COMMIT;

-- Down (manual, only before production documents exist):
-- DROP TRIGGER vendor_profile_versions_immutable ON public.vendor_profile_versions;
-- DROP TABLE public.vendor_document_pdf_bytes;
-- DROP TABLE public.vendor_document_grants;
-- DROP FUNCTION app.reject_vendor_snapshot_change();
