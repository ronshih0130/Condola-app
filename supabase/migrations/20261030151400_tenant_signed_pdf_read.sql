-- Additive tenant SELECT policy; existing team policies and writes are unchanged.
-- Read the organization flag without depending on tenant organizations RLS.
CREATE FUNCTION app.tenant_signed_pdf_on(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.organizations AS o
     WHERE o.id = p_org
       AND o.feature_flags -> 'tenant_signed_pdf' = 'true'::jsonb
  )
$$;

REVOKE ALL ON FUNCTION app.tenant_signed_pdf_on(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.tenant_signed_pdf_on(uuid)
  TO authenticated, service_role;

CREATE POLICY tenant_read_signed_pdf
  ON public.lease_signed_pdfs FOR SELECT TO authenticated
  USING (
    app.tenant_signed_pdf_on(org_id)
    AND app.is_lease_tenant(lease_id)
  );
