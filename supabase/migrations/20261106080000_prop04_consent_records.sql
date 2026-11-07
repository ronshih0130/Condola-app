-- PROP-04: read-only, user-owned acceptance evidence. No backfill or flag changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION app.prop04_my_consent_records()
RETURNS TABLE (
  kind text,
  scope_org_id uuid,
  document_ref text,
  accepted_at timestamptz,
  source text,
  record_id text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  WITH pinned_org AS (
    SELECT o.id
    FROM public.organizations o
    WHERE o.id::text = nullif(current_setting('app.active_org_id', true), '')
      AND o.environment::text = nullif(current_setting('app.env', true), '')
  ), own_contacts AS (
    SELECT c.id, c.org_id
    FROM public.contacts c JOIN pinned_org o ON o.id = c.org_id
    WHERE c.user_id = auth.uid()
  )
  SELECT 'terms_privacy'::text, NULL::uuid,
         c.terms_version || '|' || c.privacy_version,
         c.accepted_at, c.source, c.id::text
  FROM public.consents c
  WHERE c.user_id = auth.uid()
  UNION ALL
  SELECT CASE c.doc_type WHEN 'privacy' THEN 'partner_privacy' ELSE 'partner_agreement' END,
         c.company_id, c.doc_type || ':' || c.version || ':' || c.document_sha256,
         c.consented_at, 'partner_agreement_consents', c.id::text
  FROM public.partner_agreement_consents c JOIN pinned_org o ON o.id = c.company_id
  WHERE c.user_id = auth.uid() AND app.is_member(c.company_id)
  UNION ALL
  SELECT 'id_notice', d.org_id,
         notice.digest, notice.accepted_at, 'identity_documents', d.id::text
  FROM public.identity_documents d
  JOIN own_contacts c ON c.id = d.contact_id AND c.org_id = d.org_id
  -- Prefer the complete modern pair, then the complete legacy pair. Never
  -- combine a digest from one acknowledgement with the other's timestamp.
  CROSS JOIN LATERAL (
    SELECT candidate.digest, candidate.accepted_at
    FROM (VALUES
      (1, nullif(btrim(d.consent_notice_sha), ''), d.consented_at),
      (2, nullif(btrim(d.consent_notice_sha256), ''), d.consent_accepted_at)
    ) AS candidate(priority, digest, accepted_at)
    WHERE candidate.digest IS NOT NULL AND candidate.accepted_at IS NOT NULL
    ORDER BY candidate.priority
    LIMIT 1
  ) notice
  UNION ALL
  SELECT 'lease_signature', s.org_id, s.document_sha256,
         s.signed_at, 'lease_signatures', s.id::text
  FROM public.lease_signatures s JOIN pinned_org o ON o.id = s.org_id
  WHERE s.status = 'signed' AND s.signed_at IS NOT NULL
    AND nullif(btrim(s.document_sha256), '') IS NOT NULL
    AND (EXISTS (SELECT 1 FROM own_contacts c WHERE c.id = s.contact_id AND c.org_id = s.org_id)
      OR (app.is_member(s.org_id) AND EXISTS (
        SELECT 1 FROM public.org_members m
        WHERE m.id = s.member_id AND m.org_id = s.org_id AND m.user_id = auth.uid()
      )))
  UNION ALL
  SELECT 'lease_signature', c.org_id, v.content_digest,
         s.signed_at, 'esign_signers', s.version_id::text || ':' || s.id::text
  FROM public.esign_signers s
  JOIN public.esign_versions v ON v.id = s.version_id
  JOIN public.esign_cases c ON c.id = v.case_id
  JOIN pinned_org o ON o.id = c.org_id
  WHERE s.id = auth.uid() AND s.signed_at IS NOT NULL
    AND (app.is_member(c.org_id) OR EXISTS (SELECT 1 FROM own_contacts oc WHERE oc.org_id = c.org_id));
$$;
REVOKE ALL ON FUNCTION app.prop04_my_consent_records() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.prop04_my_consent_records() TO authenticated;
COMMIT;
