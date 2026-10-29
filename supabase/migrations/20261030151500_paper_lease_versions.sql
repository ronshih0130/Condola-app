-- Additive paper lease history. Existing INSERTs remain valid.
ALTER TABLE lease_signed_pdfs
  ADD COLUMN uploaded_by uuid REFERENCES auth.users(id),
  ADD COLUMN replace_reason text,
  ADD COLUMN supersedes_id uuid,
  ADD CONSTRAINT lease_signed_pdfs_org_lease_id_key
    UNIQUE (org_id, lease_id, id),
  ADD CONSTRAINT lease_signed_pdfs_replace_reason_length
    CHECK (replace_reason IS NULL OR char_length(btrim(replace_reason)) BETWEEN 1 AND 500),
  ADD CONSTRAINT lease_signed_pdfs_supersedes_reason
    CHECK (supersedes_id IS NULL OR replace_reason IS NOT NULL),
  ADD CONSTRAINT lease_signed_pdfs_supersedes_fk
    FOREIGN KEY (org_id, lease_id, supersedes_id)
    REFERENCES lease_signed_pdfs(org_id, lease_id, id);

CREATE INDEX lease_signed_pdfs_version_order_idx
  ON lease_signed_pdfs (org_id, lease_id, created_at DESC, id DESC);

-- The trigger writes atomically with replacements, including direct DB inserts,
-- without granting authenticated INSERT access to the audit ledger.
CREATE FUNCTION app.audit_paper_lease_replaced()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.audit_log (
    org_id,
    actor_user_id,
    actor_role,
    table_name,
    row_id,
    action,
    event_type,
    new_row,
    reason
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
    NEW.replace_reason
  );
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.audit_paper_lease_replaced()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER audit_paper_lease_replaced
  AFTER INSERT ON public.lease_signed_pdfs
  FOR EACH ROW
  WHEN (NEW.supersedes_id IS NOT NULL)
  EXECUTE FUNCTION app.audit_paper_lease_replaced();

-- Preserve existing RLS policies and grants, including the absence of UPDATE.
-- files.size_bytes and both source IDs remain available through the existing FK.
