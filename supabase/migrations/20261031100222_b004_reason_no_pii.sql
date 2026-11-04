-- Replacement reasons may stay on the version row when they are not email-shaped
-- or a run of six digits. Audit stores that same safe text. A reason that looks
-- like an address or a phone number is rejected, and the trigger would record
-- only the fixed code if one were already stored.
-- Re-run keeps the same check and the same function body.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  ALTER TABLE public.lease_signed_pdfs
    ADD CONSTRAINT lease_signed_pdfs_replace_reason_no_pii
    CHECK (
      replace_reason IS NULL
      OR (
        replace_reason !~ '@'
        AND replace_reason !~ '[0-9]([^0-9]{0,3}[0-9]){5}'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.audit_paper_lease_replaced()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  stored text := btrim(NEW.replace_reason);
BEGIN
  IF stored IS NULL OR stored = '' THEN
    stored := NULL;
  ELSIF stored ~ '@' OR stored ~ '[0-9]([^0-9]{0,3}[0-9]){5}' THEN
    stored := 'paper_lease_replaced';
  END IF;
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
    stored
  );
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.audit_paper_lease_replaced()
  FROM PUBLIC, anon, authenticated;
COMMIT;
