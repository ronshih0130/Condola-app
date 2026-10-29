-- Additive tenant SELECT policy; existing team policies and writes are unchanged.
-- platform_settings is the DB-level mirror of TENANT_SIGNED_PDF_ENABLED.
-- Global one-click kill: DELETE FROM public.platform_settings
-- WHERE key = 'tenant_signed_pdf'; an absent row means off.
-- Scope the flag result to a lease the caller is a tenant of.
CREATE FUNCTION app.tenant_signed_pdf_readable(p_org uuid, p_lease uuid) RETURNS boolean
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
      FROM public.organizations AS o
     WHERE o.id = p_org
       AND o.feature_flags -> 'tenant_signed_pdf' = 'true'::jsonb
  )
  AND app.is_lease_tenant(p_lease)
$$;

REVOKE ALL ON FUNCTION app.tenant_signed_pdf_readable(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.tenant_signed_pdf_readable(uuid, uuid)
  TO authenticated, service_role;

CREATE POLICY tenant_read_signed_pdf
  ON public.lease_signed_pdfs FOR SELECT TO authenticated
  USING (app.tenant_signed_pdf_readable(org_id, lease_id));
