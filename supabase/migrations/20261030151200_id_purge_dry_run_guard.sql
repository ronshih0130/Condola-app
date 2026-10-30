-- Retention stays configurable. Only explicit JSON false reopens org writes.
INSERT INTO public.platform_settings (key, value, description)
VALUES ('id_documents.org_retention_locked', 'true'::jsonb,
        'Require org retention to equal the platform cap; false reopens org writes.')
ON CONFLICT (key) DO NOTHING;

-- CREATE OR REPLACE preserves ACLs, including the existing execute revokes.
-- Keep SECURITY INVOKER and the existing unset function search_path.
CREATE OR REPLACE FUNCTION public.id_document_keep_days() RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT public.platform_max_id_retention_days()
$$;

-- Both consent clocks use the platform duration even when org writes reopen:
-- the existing no-argument helper has no organization context.
ALTER TABLE public.organizations ALTER COLUMN id_doc_retention_days
  SET DEFAULT public.platform_max_id_retention_days();

CREATE OR REPLACE FUNCTION public.fn_org_retention_guard() RETURNS trigger
SET search_path = pg_catalog, public
LANGUAGE plpgsql AS $$
DECLARE
  v_cap integer := public.platform_max_id_retention_days();
  v_locked boolean := (SELECT value FROM public.platform_settings
    WHERE key = 'id_documents.org_retention_locked') IS DISTINCT FROM 'false'::jsonb;
BEGIN
  IF (v_locked AND NEW.id_doc_retention_days IS DISTINCT FROM v_cap)
     OR (NOT v_locked AND NEW.id_doc_retention_days > v_cap) THEN
    RAISE EXCEPTION 'id_doc_retention_days % violates platform retention %',
      NEW.id_doc_retention_days, v_cap USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.fn_platform_retention_clamp() RETURNS trigger
SET search_path = pg_catalog, public
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key = 'id_documents.max_retention_days_after_close' THEN
    IF (SELECT value FROM public.platform_settings
        WHERE key = 'id_documents.org_retention_locked') = 'false'::jsonb THEN
      UPDATE public.organizations
         SET id_doc_retention_days = (NEW.value #>> '{}')::int
       WHERE id_doc_retention_days > (NEW.value #>> '{}')::int;
    END IF;
    -- Due dates are stored: config changes must reach existing live documents.
    UPDATE public.identity_documents
       SET delete_after = public.id_document_delete_after(lease_id, org_id, created_at)
     WHERE deleted_at IS NULL;
  END IF;
  RETURN NEW;
END $$;

-- Ignore legacy org values at read time; never normalize organizations here.
UPDATE public.identity_documents
   SET delete_after = public.id_document_delete_after(lease_id, org_id, created_at)
 WHERE deleted_at IS NULL
   AND delete_after IS DISTINCT FROM
       public.id_document_delete_after(lease_id, org_id, created_at);

-- Harden the existing ID-photo purge; do not introduce another scheduler.
-- Invocation summaries use the existing 'insert' audit action.

CREATE OR REPLACE FUNCTION public.preview_due_identity_documents(p_limit integer DEFAULT 500)
RETURNS TABLE (document_id uuid, storage_bucket text, storage_path text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH candidates AS MATERIALIZED (
    SELECT d.id, d.storage_bucket, d.storage_path
      FROM public.identity_documents d
     WHERE (
            d.deleted_at IS NULL AND d.delete_after <= current_date
          ) OR (
            d.deleted_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.identity_document_photos p
               WHERE p.document_id = d.id
            )
          )
     ORDER BY d.delete_after NULLS FIRST, d.id
     LIMIT greatest(1, least(1000, coalesce(p_limit, 500)))
  )
  SELECT c.id, c.storage_bucket, c.storage_path
    FROM candidates c
  UNION
  SELECT c.id, p.storage_bucket, p.storage_path
    FROM candidates c
    JOIN public.identity_document_photos p ON p.document_id = c.id
$$;

CREATE OR REPLACE FUNCTION public.purge_due_identity_documents(p_limit integer DEFAULT 500)
RETURNS TABLE (document_id uuid, storage_bucket text, storage_path text, encryption_key_ref text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
    FROM public.identity_documents d
   WHERE (
          d.deleted_at IS NULL AND d.delete_after <= current_date
        ) OR (
          d.deleted_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.identity_document_photos p
             WHERE p.document_id = d.id
          )
        )
   ORDER BY d.delete_after NULLS FIRST, d.id
   LIMIT greatest(1, least(1000, coalesce(p_limit, 500)))
     FOR UPDATE OF d SKIP LOCKED;

  INSERT INTO pg_temp.id_purge_batch (document_id, org_id, storage_bucket, storage_path, encryption_key_ref)
  SELECT b.document_id, b.org_id, p.storage_bucket, p.storage_path, b.encryption_key_ref
    FROM pg_temp.id_purge_batch b
    JOIN public.identity_document_photos p ON p.document_id = b.document_id
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_temp.id_purge_batch already
      WHERE already.storage_bucket = p.storage_bucket AND already.storage_path = p.storage_path
   );

  -- Check the entire expanded batch before deleting any original or watermark.
  -- Never include identifiers or paths in the exception.
  IF EXISTS (
    SELECT 1 FROM pg_temp.id_purge_batch b
     WHERE b.storage_bucket IS DISTINCT FROM 'id-documents-private'
        OR b.storage_path IS NULL
        OR btrim(b.storage_path) = ''
        OR left(b.storage_path, 1) = '/'
        OR strpos(b.storage_path, '..') > 0
        OR strpos(b.storage_path, chr(92)) > 0
  ) THEN
    RAISE EXCEPTION 'Unsafe ID purge target' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.id_document_wm_objects w
   USING pg_temp.id_purge_batch b
   WHERE w.bucket = b.storage_bucket AND w.path = b.storage_path || '.wm';

  DELETE FROM public.id_document_objects o
   USING pg_temp.id_purge_batch b
   WHERE o.bucket = b.storage_bucket AND o.path = b.storage_path;

  DELETE FROM public.identity_document_photos p
   USING pg_temp.id_purge_batch b
   WHERE p.document_id = b.document_id;

  UPDATE public.identity_documents d
     SET deleted_at = coalesce(d.deleted_at, now()),
         storage_path = 'purged/' || d.id::text
    FROM pg_temp.id_purge_batch b
   WHERE d.id = b.document_id;

  INSERT INTO public.identity_document_access_log (org_id, document_id, accessed_by, purpose)
  SELECT DISTINCT b.org_id, b.document_id, NULL::uuid, 'retention_purge'
    FROM pg_temp.id_purge_batch b;

  INSERT INTO public.audit_log (
    org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, new_row
  )
  SELECT DISTINCT b.org_id, NULL::uuid, 'system', 'identity_documents',
         b.document_id::text, 'update'::public.audit_action,
         'id_document_purged',
         jsonb_build_object('documentId', b.document_id, 'purpose', 'retention_purge')
    FROM pg_temp.id_purge_batch b;

  RETURN QUERY
  SELECT DISTINCT b.document_id, b.storage_bucket, b.storage_path, b.encryption_key_ref
    FROM pg_temp.id_purge_batch b;
END $$;

REVOKE ALL ON FUNCTION public.preview_due_identity_documents(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_due_identity_documents(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_due_identity_documents(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_due_identity_documents(integer)
  TO service_role;
