-- B-001 item 11 (void actor binding / CAP-P-10 e-sign evidence integrity):
-- a voided esign_versions row must have voided_by equal to the session user
-- (auth.uid()), failing closed on a NULL session, in addition to the existing
-- company-admin check. Fix-forward over LIVE 20261030150900_esign_core.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.esign_version_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  keep_until timestamptz;
  predecessor public.esign_versions;
  marker text;
BEGIN
  SELECT retention_until INTO STRICT keep_until
    FROM public.esign_cases WHERE id = NEW.case_id FOR UPDATE;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.final_digest IS NOT NULL
      OR NEW.completed_at IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'New versions start as drafts' USING ERRCODE = '23514';
    END IF;
    NEW.retention_until := keep_until;
    IF NEW.supersedes_version_id IS NOT NULL THEN
      SELECT * INTO STRICT predecessor FROM public.esign_versions
        WHERE id = NEW.supersedes_version_id AND case_id = NEW.case_id;
      IF predecessor.status <> 'fully_signed' THEN
        RAISE EXCEPTION 'Predecessor is not effective' USING ERRCODE = '23514';
      END IF;
      marker := '本版取代 ' ||
        to_char(predecessor.completed_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') ||
        ' 簽署之前版';
      IF NEW.replacement_text IS DISTINCT FROM marker OR NOT EXISTS (
        SELECT 1 FROM regexp_split_to_table(NEW.body, E'\r?\n') AS line
          WHERE trim(line) = marker
      ) THEN
        RAISE EXCEPTION 'Replacement text required' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.replacement_text IS NOT NULL THEN
      RAISE EXCEPTION 'Replacement text requires a predecessor' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY[
      'status','state','final_pdf_bytes','final_digest','completed_at',
      'void_reason','voided_by','voided_at'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'status','state','final_pdf_bytes','final_digest','completed_at',
      'void_reason','voided_by','voided_at'
    ]) THEN
      RAISE EXCEPTION 'Document content and retention are immutable' USING ERRCODE = '23514';
    END IF;

    IF OLD.status IN ('voided','superseded') THEN
      RAISE EXCEPTION 'Old version is read-only' USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'fully_signed' THEN
      IF NEW.status <> 'superseded' OR
        (to_jsonb(NEW) - ARRAY['status','state']) IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status','state']) OR
        (NEW.state - ARRAY['status','effect']) IS DISTINCT FROM
        (OLD.state - ARRAY['status','effect']) OR NOT EXISTS (
          SELECT 1 FROM public.esign_versions v
          WHERE v.case_id = OLD.case_id AND v.supersedes_version_id = OLD.id
            AND v.status = 'fully_signed'
        ) THEN
        RAISE EXCEPTION 'Both parties must complete the replacement first'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.status = 'superseded' THEN
      RAISE EXCEPTION 'Only a fully signed version can be superseded' USING ERRCODE = '23514';
    ELSIF NEW.status <> 'voided' AND NOT (
      (OLD.status = 'draft' AND NEW.status IN ('draft','sent')) OR
      (OLD.status = 'sent' AND NEW.status IN ('sent','partially_signed','fully_signed')) OR
      (OLD.status = 'partially_signed' AND NEW.status IN ('partially_signed','fully_signed'))
    ) THEN
      RAISE EXCEPTION 'Invalid version transition' USING ERRCODE = '23514';
    END IF;

    IF NEW.status = 'voided' THEN
      IF NEW.voided_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Void actor must be the session user' USING ERRCODE = '42501';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.esign_cases c JOIN public.org_members m ON m.org_id = c.org_id
        WHERE c.id = NEW.case_id AND m.user_id = NEW.voided_by
          AND m.role = 'admin' AND m.status = 'active'
      ) THEN
        RAISE EXCEPTION 'Company admin required to void' USING ERRCODE = '42501';
      END IF;
    END IF;

    IF NEW.status = 'fully_signed' AND OLD.status <> 'fully_signed' THEN
      IF EXISTS (
        SELECT 1 FROM public.esign_signers s
        WHERE s.version_id = NEW.id AND
          (s.signed_at IS NULL OR s.email_step_state <> 'completed' OR NOT EXISTS (
            SELECT 1 FROM public.esign_signature_images i
            WHERE i.version_id = s.version_id AND i.signer_id = s.id
              AND i.document_digest = NEW.content_digest
          ))
      ) OR NOT EXISTS (
        SELECT 1 FROM public.esign_signers WHERE version_id = NEW.id AND party_role = 'owner'
      ) OR NOT EXISTS (
        SELECT 1 FROM public.esign_signers WHERE version_id = NEW.id AND party_role = 'tenant'
      ) THEN
        RAISE EXCEPTION 'Both parties must sign' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status <> 'fully_signed' AND
      (NEW.final_digest IS NOT NULL OR NEW.completed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Final artifact requires both signatures' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.state->>'id' IS DISTINCT FROM NEW.id::text OR
    NEW.state->>'body' IS DISTINCT FROM NEW.body OR
    NEW.state->>'documentDigest' IS DISTINCT FROM NEW.content_digest OR
    NEW.state->>'status' IS DISTINCT FROM (CASE NEW.status
      WHEN 'fully_signed' THEN 'completed'
      WHEN 'partially_signed' THEN 'signing'
      ELSE NEW.status END) THEN
    RAISE EXCEPTION 'Domain state mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.esign_version_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.esign_version_guard() TO service_role;

COMMIT;
