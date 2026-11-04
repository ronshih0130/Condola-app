BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Tenant SELECT is scoped to the active organization and environment as well
-- as the independent global and organization gates and lease-party identity.
-- An unpinned legacy session may read its live lease; sandbox requires pins.
CREATE OR REPLACE FUNCTION app.tenant_signed_pdf_readable(p_org uuid, p_lease uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_settings s
     WHERE s.key = 'tenant_signed_pdf' AND s.value = 'true'::jsonb
  ) AND EXISTS (
    SELECT 1 FROM public.leases l JOIN public.organizations o ON o.id = l.org_id
     WHERE l.id = p_lease AND l.org_id = p_org
       AND o.feature_flags -> 'tenant_signed_pdf' = 'true'::jsonb
       AND (
         (nullif(current_setting('app.active_org_id', true), '') IS NULL
          AND o.environment::text = 'live'
          AND coalesce(nullif(current_setting('app.env', true), ''), 'live') = 'live')
         OR
         (current_setting('app.active_org_id', true) = o.id::text
          AND current_setting('app.env', true) = o.environment::text)
       )
  ) AND app.is_lease_tenant(p_lease)
$$;
REVOKE ALL ON FUNCTION app.tenant_signed_pdf_readable(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.tenant_signed_pdf_readable(uuid, uuid) TO authenticated, service_role;

-- Normal callers cannot modify or delete individual versions. Preserve existing FK
-- cascades only when an actual parent was deleted; database owners can bypass
-- triggers, so this is not a claim of universal or indefinite retention.
CREATE OR REPLACE FUNCTION app.guard_paper_lease_version_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND (
    NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = OLD.org_id)
    OR NOT EXISTS (SELECT 1 FROM public.leases l WHERE l.org_id = OLD.org_id AND l.id = OLD.lease_id)
    OR NOT EXISTS (SELECT 1 FROM public.files f WHERE f.org_id = OLD.org_id AND f.id = OLD.file_id)
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Paper lease versions cannot be changed directly' USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION app.guard_paper_lease_version_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.guard_paper_lease_version_delete() TO service_role;
DROP TRIGGER IF EXISTS guard_paper_lease_version_delete ON public.lease_signed_pdfs;
CREATE TRIGGER guard_paper_lease_version_delete
  BEFORE UPDATE OR DELETE ON public.lease_signed_pdfs
  FOR EACH ROW EXECUTE FUNCTION app.guard_paper_lease_version_delete();
COMMIT;
