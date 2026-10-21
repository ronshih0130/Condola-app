-- Version 20261026110000.
-- Private receipt files for expenses and payments.
--
-- Backward compatible with the Worker that is still serving:
-- * No new columns, no NOT NULL, no renames, no drops.
-- * No unique index.
-- * Checks apply only when storage_bucket = 'receipts-private'.
--   Older code still inserts placeholder rows into bucket 'receipts'
--   (path demo/<uuid>.txt, mime text/plain). Those rows do not match
--   this check and keep inserting.
-- * The bucket and storage policies are new objects. Older code never
--   writes this bucket, so the policies do not change its uploads.
-- * The extra SELECT policy only grants reads. It does not narrow
--   team_read or portal_files_own_read.

ALTER TABLE files DROP CONSTRAINT IF EXISTS files_receipt_cap;
ALTER TABLE files
  ADD CONSTRAINT files_receipt_cap
  CHECK (
    storage_bucket <> 'receipts-private'
    OR (
      size_bytes IS NOT NULL
      AND size_bytes > 0
      AND size_bytes <= 10485760
      AND mime_type IN ('image/jpeg', 'image/png', 'application/pdf')
    )
  );

ALTER TABLE files DROP CONSTRAINT IF EXISTS files_receipt_path;
ALTER TABLE files
  ADD CONSTRAINT files_receipt_path
  CHECK (
    storage_bucket <> 'receipts-private'
    OR storage_path ~* (
      '^org/' || org_id::text || '/receipts/' || id::text || '\.(jpg|png|pdf)$'
    )
  );

-- Org members already read files through team_read. This adds the payer,
-- so a 租客 can open the proof attached to their own payment.
DROP POLICY IF EXISTS receipt_file_read ON files;
CREATE POLICY receipt_file_read ON files FOR SELECT TO authenticated
  USING (
    storage_bucket = 'receipts-private'
    AND (
      app.is_member(org_id)
      OR uploaded_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM payments p
         WHERE p.proof_file_id = files.id
           AND p.org_id = files.org_id
           AND app.is_lease_tenant(p.lease_id)
      )
    )
  );

-- Private bucket when this database is hosted Supabase. Local Postgres has no
-- storage schema; the files check constraint still caps the row.
DO $receipts$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO storage.buckets (id, name, "public", file_size_limit, allowed_mime_types)
  VALUES (
    'receipts-private',
    'receipts-private',
    false,
    10485760,
    ARRAY['image/jpeg', 'image/png', 'application/pdf']::text[]
  )
  ON CONFLICT (id) DO UPDATE
    SET "public" = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

  IF to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS receipt_object_read ON storage.objects';
  EXECUTE $policy$
    CREATE POLICY receipt_object_read ON storage.objects FOR SELECT TO authenticated
    USING (
      bucket_id = 'receipts-private'
      AND split_part(name, '/', 1) = 'org'
      AND split_part(name, '/', 2) ~ '^[0-9a-fA-F-]{36}$'
      AND app.is_member(split_part(name, '/', 2)::uuid)
    )
  $policy$;

  EXECUTE 'DROP POLICY IF EXISTS receipt_object_tenant_read ON storage.objects';
  EXECUTE $policy$
    CREATE POLICY receipt_object_tenant_read ON storage.objects FOR SELECT TO authenticated
    USING (
      bucket_id = 'receipts-private'
      AND EXISTS (
        SELECT 1 FROM public.files f
          JOIN public.payments p ON p.proof_file_id = f.id AND p.org_id = f.org_id
         WHERE f.storage_bucket = 'receipts-private'
           AND f.storage_path = name
           AND app.is_lease_tenant(p.lease_id)
      )
    )
  $policy$;

  EXECUTE 'DROP POLICY IF EXISTS receipt_object_insert ON storage.objects';
  EXECUTE $policy$
    CREATE POLICY receipt_object_insert ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (
      bucket_id = 'receipts-private'
      AND split_part(name, '/', 1) = 'org'
      AND split_part(name, '/', 2) ~ '^[0-9a-fA-F-]{36}$'
      AND app.is_member(split_part(name, '/', 2)::uuid)
    )
  $policy$;
END
$receipts$;
