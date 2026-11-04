-- Additive tenant SELECT policy; existing team policies and writes are unchanged.
-- Two independent gates must both be ON for tenant reads through app routes:
-- TENANT_SIGNED_PDF_ENABLED gates app routes; platform_settings gates DB reads.
-- Either gate alone is insufficient to enable tenant reads through app routes.
-- The DB gate also governs direct DB/PostgREST tenant reads, where the code
-- constant does not execute. These switches are not synchronized mirrors.
-- DB-layer one-click kill: DELETE FROM public.platform_settings
-- WHERE key = 'tenant_signed_pdf'; an absent row means off.
-- Scope the flag result to the supplied organization and a lease the caller owns.
-- Re-run is safe. A later migration replaces this helper; running this file
-- again before that migration restores this body, and the later file restores
-- the final body. The policy and grants match the first apply.
CREATE OR REPLACE FUNCTION app.tenant_signed_pdf_readable(p_org uuid, p_lease uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.platform_settings AS s
     WHERE s.key = 'tenant_signed_pdf'
       AND s.value = 'true'::jsonb
  )
  AND EXISTS (
    SELECT 1
      FROM public.leases AS l
     WHERE l.id = p_lease
       AND l.org_id = p_org
  )
  AND EXISTS (
    SELECT 1
      FROM public.organizations AS o
     WHERE o.id = p_org
       AND o.feature_flags -> 'tenant_signed_pdf' = 'true'::jsonb
  )
  AND app.is_lease_tenant(p_lease)
$$;

REVOKE ALL ON FUNCTION app.tenant_signed_pdf_readable(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.tenant_signed_pdf_readable(uuid, uuid)
  TO authenticated, service_role;

DROP POLICY IF EXISTS tenant_read_signed_pdf ON public.lease_signed_pdfs;
CREATE POLICY tenant_read_signed_pdf
  ON public.lease_signed_pdfs FOR SELECT TO authenticated
  USING (app.tenant_signed_pdf_readable(org_id, lease_id));
