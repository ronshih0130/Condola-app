-- Version 20261029150000.
-- A second ciphertext for each ID photo. Signed reads return this copy.
-- The original stays in id_document_objects and is not returned by id_photo_open.
-- No new constraint on identity_document_photos. Old inserts that omit the
-- watermarked object still succeed; a view generates the copy or gets no bytes.

CREATE TABLE IF NOT EXISTS id_document_wm_objects (
  bucket text NOT NULL DEFAULT 'id-documents-private',
  path text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,
  ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, path)
);

ALTER TABLE id_document_wm_objects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE id_document_wm_objects FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE id_document_wm_objects TO service_role;

CREATE OR REPLACE FUNCTION public.fn_id_photo_drop_wm()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.id_document_wm_objects
   WHERE bucket = OLD.storage_bucket
     AND path = OLD.storage_path || '.wm';
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_id_photo_drop_wm ON public.identity_document_photos;
CREATE TRIGGER trg_id_photo_drop_wm
  BEFORE DELETE ON public.identity_document_photos
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_id_photo_drop_wm();

CREATE OR REPLACE FUNCTION public.id_photo_open(
  p_token_hash text,
  p_user_id uuid,
  p_document_id uuid,
  p_slot text,
  p_preferred_org text,
  p_env text
) RETURNS TABLE (
  user_id uuid,
  viewer_name text,
  email text,
  firm_name text,
  tenant_name text,
  contact_id uuid,
  org_id uuid,
  kind text,
  mime_type text,
  encryption_key_ref text,
  total_bytes integer,
  seq integer,
  chunk bytea
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT g.user_id,
         g.viewer_name,
         g.email,
         g.firm_name,
         g.tenant_name,
         g.contact_id,
         g.org_id,
         g.kind,
         coalesce(wm.mime_type, ph.mime_type),
         g.encryption_key_ref,
         coalesce(octet_length(wm.ciphertext), 0)::integer,
         parts.i,
         CASE
           WHEN wm.ciphertext IS NULL THEN '\x'::bytea
           ELSE substring(wm.ciphertext FROM parts.i FOR 24576)
         END
    FROM public.id_photo_gate(p_token_hash, p_user_id, p_document_id, p_preferred_org, p_env) AS g
    JOIN public.identity_document_photos ph
      ON ph.document_id = g.document_id AND ph.slot = p_slot
    LEFT JOIN public.id_document_wm_objects wm
      ON wm.bucket = ph.storage_bucket AND wm.path = ph.storage_path || '.wm'
    CROSS JOIN LATERAL (
      SELECT gs.i
        FROM generate_series(1, octet_length(wm.ciphertext), 24576) AS gs(i)
       WHERE wm.ciphertext IS NOT NULL
      UNION ALL
      SELECT 0
       WHERE wm.ciphertext IS NULL
    ) AS parts(i)
   ORDER BY parts.i
$$;

CREATE OR REPLACE FUNCTION purge_due_identity_documents(p_limit integer DEFAULT 500)
RETURNS TABLE (document_id uuid, storage_bucket text, storage_path text, encryption_key_ref text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DROP TABLE IF EXISTS pg_temp.id_purge_batch;
  CREATE TEMP TABLE id_purge_batch (
    document_id uuid,
    org_id uuid,
    storage_bucket text,
    storage_path text,
    encryption_key_ref text
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.id_purge_batch
  SELECT d.id, d.org_id, d.storage_bucket, d.storage_path, d.encryption_key_ref
    FROM identity_documents d
   WHERE (
          d.deleted_at IS NULL AND d.delete_after <= current_date
        ) OR (
          d.deleted_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM identity_document_photos p WHERE p.document_id = d.id)
        )
   ORDER BY d.delete_after NULLS FIRST, d.id
   LIMIT p_limit
     FOR UPDATE OF d SKIP LOCKED;

  INSERT INTO pg_temp.id_purge_batch (document_id, org_id, storage_bucket, storage_path, encryption_key_ref)
  SELECT b.document_id, b.org_id, p.storage_bucket, p.storage_path, b.encryption_key_ref
    FROM pg_temp.id_purge_batch b
    JOIN identity_document_photos p ON p.document_id = b.document_id
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_temp.id_purge_batch already
      WHERE already.storage_bucket = p.storage_bucket AND already.storage_path = p.storage_path
   );

  DELETE FROM id_document_wm_objects w
   USING pg_temp.id_purge_batch b
   WHERE w.bucket = b.storage_bucket AND w.path = b.storage_path || '.wm';

  DELETE FROM id_document_objects o
   USING pg_temp.id_purge_batch b
   WHERE o.bucket = b.storage_bucket AND o.path = b.storage_path;

  DELETE FROM identity_document_photos p
   USING pg_temp.id_purge_batch b
   WHERE p.document_id = b.document_id;

  UPDATE identity_documents d
     SET deleted_at = coalesce(d.deleted_at, now()),
         storage_path = 'purged/' || d.id::text
    FROM pg_temp.id_purge_batch b
   WHERE d.id = b.document_id;

  INSERT INTO identity_document_access_log (org_id, document_id, accessed_by, purpose)
  SELECT DISTINCT b.org_id, b.document_id, NULL::uuid, 'retention_purge'
    FROM pg_temp.id_purge_batch b;

  INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, new_row)
  SELECT DISTINCT b.org_id, NULL::uuid, 'system', 'identity_documents', b.document_id::text, 'update'::audit_action,
         'id_document_purged', jsonb_build_object('documentId', b.document_id, 'purpose', 'retention_purge')
    FROM pg_temp.id_purge_batch b;

  RETURN QUERY
  SELECT DISTINCT b.document_id, b.storage_bucket, b.storage_path, b.encryption_key_ref
    FROM pg_temp.id_purge_batch b;
END $$;
