-- Version 20261030151300: company-scoped, server-recorded partner acceptances.
-- No setting is inserted: a missing global setting keeps the feature off.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.partner_agreement_consents (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  doc_type text NOT NULL CHECK (doc_type IN ('privacy', 'partner_agreement')),
  version text NOT NULL CHECK (pg_catalog.btrim(version) <> ''),
  locale text NOT NULL CHECK (pg_catalog.btrim(locale) <> ''),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  consented_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  ip_address inet NULL,
  user_agent text NULL CHECK (pg_catalog.char_length(user_agent) <= 512),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE INDEX IF NOT EXISTS partner_agreement_consents_company_version_idx
  ON public.partner_agreement_consents (company_id, doc_type, version);

ALTER TABLE public.partner_agreement_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.partner_agreement_consents FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.partner_agreement_consents TO service_role;
GRANT SELECT ON TABLE public.partner_agreement_consents TO authenticated;
DROP POLICY IF EXISTS partner_agreement_consents_staff_read ON public.partner_agreement_consents;
CREATE POLICY partner_agreement_consents_staff_read ON public.partner_agreement_consents
  FOR SELECT TO authenticated USING (app.is_member(company_id));

CREATE OR REPLACE FUNCTION public.partner_agreement_consents_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  -- Permit only the actual parent-company FK cascade, after its parent is gone.
  IF TG_OP = 'DELETE' AND pg_catalog.pg_trigger_depth() > 1 THEN
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.company_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'partner agreement consents are append-only' USING ERRCODE = '42501';
END
$function$;
REVOKE EXECUTE ON FUNCTION public.partner_agreement_consents_append_only()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS partner_agreement_consents_append_only ON public.partner_agreement_consents;
CREATE TRIGGER partner_agreement_consents_append_only
  BEFORE UPDATE OR DELETE ON public.partner_agreement_consents
  FOR EACH ROW EXECUTE FUNCTION public.partner_agreement_consents_append_only();
DROP TRIGGER IF EXISTS partner_agreement_consents_no_truncate ON public.partner_agreement_consents;
CREATE TRIGGER partner_agreement_consents_no_truncate
  BEFORE TRUNCATE ON public.partner_agreement_consents
  FOR EACH STATEMENT EXECUTE FUNCTION public.partner_agreement_consents_append_only();

RESET lock_timeout;
RESET statement_timeout;
