-- Tenant ID check: private photo bucket, review status, fixed retention.
-- Do not edit earlier migrations. Leases already exist on main, so a check is
-- keyed to the lease when one exists.
-- TODO(LIFF): onboarding may collect the photos before a lease row exists.
-- lease_id stays nullable; contact_id is the subject until the lease is linked.
--
-- Retention is not a setting. delete_after is computed as the lease move-out
-- date (terminated_on, else end_date) plus 365 days. Deposit settlement does
-- not move the date. The number matches DEFAULT_RETENTION_DAYS in src/lib/idv.ts.

CREATE OR REPLACE FUNCTION id_document_keep_days() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 365 $$;

-- Move-out date + the fixed keep period. NULL until the lease has an end date.
CREATE OR REPLACE FUNCTION id_document_delete_after(p_lease_id uuid) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT coalesce(l.terminated_on, l.end_date) + id_document_keep_days()
    FROM leases l
   WHERE l.id = p_lease_id
$$;

CREATE TYPE id_review_status AS ENUM ('pending_review', 'checked', 'returned');

ALTER TABLE identity_documents
  ADD COLUMN review_status id_review_status NOT NULL DEFAULT 'pending_review',
  ADD COLUMN return_reason text,
  ADD COLUMN reviewed_by uuid REFERENCES auth.users(id),
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN consent_accepted_at timestamptz,
  ADD COLUMN lease_id uuid,
  ADD COLUMN is_sample boolean NOT NULL DEFAULT false,
  ADD COLUMN delete_after date;

ALTER TABLE identity_documents DROP COLUMN verified_by, DROP COLUMN verified_at;

CREATE OR REPLACE FUNCTION fn_id_document_delete_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.delete_after := id_document_delete_after(NEW.lease_id);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_id_document_delete_after
  BEFORE INSERT OR UPDATE OF lease_id ON identity_documents
  FOR EACH ROW EXECUTE FUNCTION fn_id_document_delete_after();

CREATE OR REPLACE FUNCTION fn_lease_refresh_id_delete_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE identity_documents
     SET delete_after = id_document_delete_after(NEW.id)
   WHERE lease_id = NEW.id
     AND deleted_at IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lease_refresh_id_delete_after
  AFTER UPDATE OF end_date, terminated_on ON leases
  FOR EACH ROW EXECUTE FUNCTION fn_lease_refresh_id_delete_after();

-- TODO(LIFF): a check can exist before its lease. Linking the contact as the
-- primary tenant fills lease_id, which recomputes delete_after.
CREATE OR REPLACE FUNCTION fn_link_orphan_id_document() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.role = 'primary' THEN
    UPDATE identity_documents AS doc
       SET lease_id = NEW.lease_id
     WHERE doc.org_id = NEW.org_id
       AND doc.contact_id = NEW.contact_id
       AND doc.lease_id IS NULL
       AND doc.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM identity_documents AS existing
          WHERE existing.org_id = NEW.org_id
            AND existing.contact_id = NEW.contact_id
            AND existing.lease_id = NEW.lease_id
            AND existing.deleted_at IS NULL
       );
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_link_orphan_id_document
  AFTER INSERT ON lease_parties
  FOR EACH ROW EXECUTE FUNCTION fn_link_orphan_id_document();

ALTER TABLE identity_documents
  ADD CONSTRAINT identity_documents_org_id_uniq UNIQUE (org_id, id);

ALTER TABLE identity_documents
  ADD CONSTRAINT identity_documents_lease_fk
  FOREIGN KEY (org_id, lease_id) REFERENCES leases (org_id, id) ON DELETE CASCADE;

ALTER TABLE identity_documents
  ADD CONSTRAINT identity_documents_returned_ck
  CHECK (review_status <> 'returned' OR (return_reason IS NOT NULL AND length(btrim(return_reason)) > 0));

ALTER TABLE identity_documents
  ADD CONSTRAINT identity_documents_checked_ck
  CHECK (review_status <> 'checked' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL));

ALTER TABLE identity_documents
  ADD CONSTRAINT identity_documents_masked_ck
  CHECK (number_masked IS NULL OR number_masked LIKE '%*%');

CREATE UNIQUE INDEX identity_documents_current_idx
  ON identity_documents (org_id, contact_id, coalesce(lease_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;

CREATE INDEX identity_documents_lease_idx ON identity_documents (lease_id) WHERE lease_id IS NOT NULL;

-- Full numbers are refused even if a star is appended.
CREATE OR REPLACE FUNCTION fn_id_number_masked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.number_masked IS NOT NULL AND NEW.number_masked !~ '\*{2,}' THEN
    RAISE EXCEPTION 'identity number must be stored masked' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.number_masked ~ '^[A-Z][0-9]{9}' THEN
    RAISE EXCEPTION 'identity number must be stored masked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_identity_documents_masked
  BEFORE INSERT OR UPDATE OF number_masked ON identity_documents
  FOR EACH ROW EXECUTE FUNCTION fn_id_number_masked();

CREATE TABLE identity_document_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  document_id uuid NOT NULL,
  slot text NOT NULL CHECK (slot IN ('front', 'back', 'selfie')),
  storage_bucket text NOT NULL DEFAULT 'id-documents-private',
  storage_path text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5000000),
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, slot),
  UNIQUE (storage_bucket, storage_path),
  FOREIGN KEY (org_id, document_id) REFERENCES identity_documents (org_id, id) ON DELETE CASCADE
);

-- Private bucket. Bytes are readable only by service_role (signed-URL route).
CREATE TABLE id_document_objects (
  bucket text NOT NULL DEFAULT 'id-documents-private',
  path text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 8000000),
  sha256 text NOT NULL,
  ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, path)
);

ALTER TABLE identity_document_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE id_document_objects ENABLE ROW LEVEL SECURITY;

CREATE POLICY idphoto_team ON identity_document_photos FOR SELECT TO authenticated
  USING (app.has_role(org_id, '{admin,manager}'));
CREATE POLICY idphoto_self ON identity_document_photos FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM identity_documents d
     WHERE d.id = document_id AND d.deleted_at IS NULL AND app.is_my_contact(d.contact_id)
  ));

-- Tenant inserts cannot mark a document checked or flag it as a sample.
DROP POLICY IF EXISTS iddoc_self_insert ON identity_documents;
CREATE POLICY iddoc_self_insert ON identity_documents FOR INSERT TO authenticated
  WITH CHECK (
    app.is_my_contact(contact_id)
    AND created_by = auth.uid()
    AND review_status = 'pending_review'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND is_sample = false
    AND deleted_at IS NULL
  );

-- Photos never travel with an export.
ALTER TABLE export_jobs
  ADD CONSTRAINT export_jobs_no_identity_documents CHECK (include_identity_documents = false);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity_document_photos, id_document_objects TO service_role;
GRANT SELECT ON identity_document_photos TO authenticated;
REVOKE ALL ON id_document_objects FROM PUBLIC, authenticated;
REVOKE INSERT, UPDATE, DELETE ON identity_document_photos FROM authenticated;

-- Purge shreds the private objects. Due when the computed delete_after has passed.
CREATE OR REPLACE VIEW id_documents_due_for_purge WITH (security_invoker = true) AS
SELECT d.id AS document_id, d.org_id, d.contact_id, d.doc_type, d.storage_bucket, d.storage_path, d.encryption_key_ref,
       coalesce(l.terminated_on, l.end_date) AS closed_on,
       l.deposit_settled_at AS last_deposit_settled_at,
       id_document_keep_days()::smallint AS retention_days,
       d.delete_after AS due_on
  FROM identity_documents d
  LEFT JOIN leases l ON l.id = d.lease_id
 WHERE d.deleted_at IS NULL
   AND d.delete_after IS NOT NULL
   AND d.delete_after <= current_date;
CREATE OR REPLACE FUNCTION purge_due_identity_documents(p_limit integer DEFAULT 500)
RETURNS TABLE (document_id uuid, storage_bucket text, storage_path text, encryption_key_ref text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DROP TABLE IF EXISTS id_purge_batch;
  CREATE TEMP TABLE id_purge_batch (
    document_id uuid,
    org_id uuid,
    storage_bucket text,
    storage_path text,
    encryption_key_ref text
  ) ON COMMIT DROP;

  INSERT INTO id_purge_batch
  SELECT v.document_id, v.org_id, v.storage_bucket, v.storage_path, v.encryption_key_ref
    FROM id_documents_due_for_purge v
   ORDER BY v.due_on
   LIMIT p_limit;

  INSERT INTO id_purge_batch (document_id, org_id, storage_bucket, storage_path, encryption_key_ref)
  SELECT b.document_id, b.org_id, p.storage_bucket, p.storage_path, b.encryption_key_ref
    FROM id_purge_batch b
    JOIN identity_document_photos p ON p.document_id = b.document_id
   WHERE NOT EXISTS (
     SELECT 1 FROM id_purge_batch already
      WHERE already.storage_bucket = p.storage_bucket AND already.storage_path = p.storage_path
   );

  DELETE FROM id_document_objects o
   USING id_purge_batch b
   WHERE o.bucket = b.storage_bucket AND o.path = b.storage_path;

  DELETE FROM identity_document_photos p
   USING id_purge_batch b
   WHERE p.document_id = b.document_id;

  UPDATE identity_documents d
     SET deleted_at = now(),
         storage_path = 'purged/' || d.id::text
    FROM id_purge_batch b
   WHERE d.id = b.document_id
     AND d.deleted_at IS NULL;

  INSERT INTO identity_document_access_log (org_id, document_id, accessed_by, purpose)
  SELECT DISTINCT b.org_id, b.document_id, auth.uid(), 'retention_purge'
    FROM id_purge_batch b;

  RETURN QUERY
  SELECT DISTINCT b.document_id, b.storage_bucket, b.storage_path, b.encryption_key_ref
    FROM id_purge_batch b;
END $$;
