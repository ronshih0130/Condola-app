BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Policy helpers remain executable by authenticated for RLS evaluation, but
-- live outside the API-exposed public schema. Respect explicit org and
-- environment pins for signers as well as for organization members.
CREATE FUNCTION app.esign_context_matches(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organizations o WHERE o.id = p_org AND (
      (o.environment::text = 'sandbox'
        AND nullif(current_setting('app.active_org_id', true), '') = o.id::text
        AND nullif(current_setting('app.env', true), '') = 'sandbox')
      OR (o.environment::text = 'live'
        AND (nullif(current_setting('app.active_org_id', true), '') IS NULL
          OR current_setting('app.active_org_id', true) = o.id::text)
        AND (nullif(current_setting('app.env', true), '') IS NULL
          OR current_setting('app.env', true) = 'live'))
    )
  );
$$;

CREATE FUNCTION app.esign_can_read(p_case uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.esign_cases c
    WHERE c.id = p_case AND app.esign_context_matches(c.org_id)
      AND (app.has_role(c.org_id, ARRAY['admin','manager']::public.org_role[]) OR EXISTS (
        SELECT 1 FROM public.esign_versions v
        JOIN public.esign_signers s ON s.version_id = v.id
        WHERE v.case_id = c.id AND s.id = auth.uid()
      ))
  );
$$;

CREATE FUNCTION app.esign_is_management(p_case uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.esign_cases c WHERE c.id = p_case
      AND app.esign_context_matches(c.org_id)
      AND app.has_role(c.org_id, ARRAY['admin','manager']::public.org_role[])
  );
$$;

CREATE FUNCTION app.esign_can_read_version(p_version uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.esign_versions v
    JOIN public.esign_cases c ON c.id = v.case_id
    WHERE v.id = p_version AND app.esign_context_matches(c.org_id)
      AND (app.esign_is_management(c.id) OR EXISTS (
        SELECT 1 FROM public.esign_signers s
        WHERE s.version_id = v.id AND s.id = auth.uid()
      ))
  );
$$;

CREATE FUNCTION app.esign_audit_summary(p_case uuid)
RETURNS TABLE (version_id uuid, signer_id uuid, signed_at timestamptz, email_step_state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.version_id, s.id, s.signed_at, s.email_step_state
  FROM public.esign_versions v JOIN public.esign_signers s ON s.version_id = v.id
  WHERE v.case_id = p_case AND app.esign_can_read(p_case)
    AND (app.esign_is_management(p_case) OR s.id = auth.uid());
$$;

REVOKE ALL ON FUNCTION app.esign_context_matches(uuid), app.esign_can_read(uuid),
  app.esign_is_management(uuid), app.esign_can_read_version(uuid),
  app.esign_audit_summary(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.esign_context_matches(uuid), app.esign_can_read(uuid),
  app.esign_is_management(uuid), app.esign_can_read_version(uuid),
  app.esign_audit_summary(uuid) TO authenticated, service_role;

ALTER POLICY esign_cases_read ON public.esign_cases USING (app.esign_can_read(id));
ALTER POLICY esign_versions_read ON public.esign_versions USING (app.esign_can_read_version(id));
ALTER POLICY esign_signers_read ON public.esign_signers USING (
  EXISTS (SELECT 1 FROM public.esign_versions v WHERE v.id = esign_signers.version_id
    AND app.esign_can_read(v.case_id)
    AND (esign_signers.id = auth.uid() OR app.esign_is_management(v.case_id)))
);
ALTER POLICY esign_images_read ON public.esign_signature_images USING (
  app.esign_is_management((SELECT case_id FROM public.esign_versions WHERE id = version_id))
);
ALTER POLICY esign_audit_read ON public.esign_audit_events USING (app.esign_is_management(case_id));
ALTER POLICY esign_retention_extensions_read ON public.esign_retention_extensions USING (app.esign_can_read(case_id));

-- Old signatures remain available to service_role for compatibility.
REVOKE EXECUTE ON FUNCTION public.esign_can_read(uuid), public.esign_is_management(uuid),
  public.esign_audit_summary(uuid) FROM PUBLIC, anon, authenticated;
COMMIT;
