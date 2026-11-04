-- Replacement reasons are a fixed set of codes. Audit stores that code only.
-- Local disposable lease_signed_pdfs had 0 rows when this was written.
-- Hosted databases were not read. A non-code row stops this migration.
-- The update to 'other' runs only after that count is 0, so it changes nothing.
-- Re-run keeps the same check and the same function body.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  pending integer;
BEGIN
  SELECT count(*) INTO pending
    FROM public.lease_signed_pdfs
   WHERE replace_reason IS NOT NULL
     AND replace_reason NOT IN (
       'corrected_signature', 'wrong_file', 'illegible_scan', 'other'
     );
  IF pending > 0 THEN
    RAISE EXCEPTION
      'b004_reason_codes: % lease_signed_pdfs.replace_reason rows are not codes; refusing to map them',
      pending
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.lease_signed_pdfs
     SET replace_reason = 'other'
   WHERE replace_reason IS NOT NULL
     AND replace_reason NOT IN (
       'corrected_signature', 'wrong_file', 'illegible_scan', 'other'
     );
END $$;

ALTER TABLE public.lease_signed_pdfs
  DROP CONSTRAINT IF EXISTS lease_signed_pdfs_replace_reason_no_pii;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lease_signed_pdfs_replace_reason_code'
  ) THEN
    ALTER TABLE public.lease_signed_pdfs
      ADD CONSTRAINT lease_signed_pdfs_replace_reason_code
      CHECK (
        replace_reason IS NULL
        OR replace_reason IN (
          'corrected_signature', 'wrong_file', 'illegible_scan', 'other'
        )
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.audit_paper_lease_replaced()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  code text := CASE btrim(NEW.replace_reason)
    WHEN 'corrected_signature' THEN 'corrected_signature'
    WHEN 'wrong_file' THEN 'wrong_file'
    WHEN 'illegible_scan' THEN 'illegible_scan'
    WHEN 'other' THEN 'other'
    ELSE NULL
  END;
BEGIN
  INSERT INTO public.audit_log (
    org_id, actor_user_id, actor_role, table_name, row_id, action,
    event_type, new_row, reason
  )
  VALUES (
    NEW.org_id,
    NEW.uploaded_by,
    'app',
    'lease_signed_pdfs',
    NEW.id::text,
    'insert',
    'paper_lease_replaced',
    jsonb_build_object(
      'lease_id', NEW.lease_id,
      'lease_signed_pdf_id', NEW.id,
      'file_id', NEW.file_id,
      'size_bytes', octet_length(NEW.content),
      'supersedes_id', NEW.supersedes_id
    ),
    code
  );
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.audit_paper_lease_replaced()
  FROM PUBLIC, anon, authenticated;
COMMIT;
