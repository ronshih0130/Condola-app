BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- B-002: enforce the fixed policy at the access and purge boundaries.
-- Existing cached dates and organization settings are retained for audit.
ALTER TABLE public.leases ADD COLUMN id_retention_auto_end boolean;

-- Runs before trg_lease_close_end_date. Client-provided provenance is ignored.
-- Previously closed rows with a non-null end retain NULL (unknown).
CREATE FUNCTION app.b002_capture_end_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.id_retention_auto_end := NEW.status IN ('terminated','cancelled') AND NEW.end_date IS NULL;
  ELSE
    NEW.id_retention_auto_end := OLD.id_retention_auto_end;
    IF OLD.end_date IS NULL AND NEW.end_date IS NULL AND NEW.status IN ('terminated','cancelled') THEN
      NEW.id_retention_auto_end := true;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b002_capture_end_origin() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER aaa_b002_capture_end_origin
  BEFORE INSERT OR UPDATE ON public.leases
  FOR EACH ROW EXECUTE FUNCTION app.b002_capture_end_origin();

-- Unknown origin means no purge and no photo access until reconciled.
CREATE FUNCTION app.b002_retention_origin_known(p_lease_id uuid, p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_lease_id IS NULL OR EXISTS (
    SELECT 1 FROM public.leases l WHERE l.id=p_lease_id AND l.org_id=p_org_id
      AND NOT (l.esign_status NOT IN ('voided','declined')
        AND (l.status IN ('active','ended','terminated') OR
          (l.status NOT IN ('cancelled','draft') AND (l.signed_at IS NOT NULL OR l.esign_status = 'fully_signed')))
        AND (l.end_date IS NOT NULL OR l.terminated_on IS NOT NULL OR l.moved_out_on IS NOT NULL OR l.status IN ('ended','terminated'))
        AND l.id_retention_auto_end IS NULL)
  )
$$;
REVOKE ALL ON FUNCTION app.b002_retention_origin_known(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b002_retention_origin_known(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.id_document_keep_days() RETURNS integer
LANGUAGE sql STABLE AS $$ SELECT 90 $$;

CREATE OR REPLACE FUNCTION public.id_document_delete_after(p_lease_id uuid, p_org_id uuid, p_created_at timestamptz)
RETURNS date LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_end date;
  v_terminated date;
  v_moved date;
  v_formed boolean;
  v_auto_end boolean;
  v_status text;
BEGIN
  IF p_lease_id IS NOT NULL THEN
    SELECT l.end_date, l.terminated_on, l.moved_out_on, l.id_retention_auto_end, l.status::text,
           l.esign_status NOT IN ('voided', 'declined') AND
             (l.status IN ('active', 'ended', 'terminated') OR
              (l.status NOT IN ('cancelled', 'draft') AND
               (l.signed_at IS NOT NULL OR l.esign_status = 'fully_signed')))
      INTO v_end, v_terminated, v_moved, v_auto_end, v_status, v_formed
      FROM public.leases l WHERE l.id = p_lease_id AND l.org_id = p_org_id;
    -- A missing or cross-organization lease cannot authorize earlier deletion.
    IF NOT FOUND THEN RETURN DATE '9999-12-31'; END IF;
  END IF;
  IF v_formed THEN
    IF v_auto_end IS NULL AND (v_end IS NOT NULL OR v_terminated IS NOT NULL OR v_moved IS NOT NULL OR v_status IN ('ended','terminated')) THEN RETURN DATE '9999-12-31'; END IF;
    IF v_auto_end IS TRUE THEN
      IF v_terminated IS NOT NULL OR v_moved IS NOT NULL THEN RETURN greatest(v_terminated, v_moved) + 90; END IF;
      RETURN DATE '9999-12-31';
    END IF;
    IF v_end IS NOT NULL THEN RETURN coalesce(v_terminated, v_end) + 90; END IF;
    IF v_terminated IS NOT NULL OR v_moved IS NOT NULL THEN RETURN greatest(v_terminated, v_moved) + 90; END IF;
    RETURN DATE '9999-12-31';
  END IF;
  RETURN (timezone('Asia/Taipei', coalesce(p_created_at, now())))::date + 90;
END $$;

CREATE OR REPLACE FUNCTION public.id_photo_gate(
  p_token_hash text,
  p_user_id uuid,
  p_document_id uuid,
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
  document_id uuid,
  kind text,
  encryption_key_ref text,
  slots text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH sess AS (
    SELECT s.user_id AS user_id,
           coalesce(p.email::text, u.email::text) AS email,
           coalesce(
             nullif(btrim(p.display_name), ''),
             nullif(split_part(coalesce(p.email::text, u.email::text, ''), '@', 1), ''),
             'user'
           ) AS viewer_name
      FROM public.auth_sessions s
      JOIN auth.users u ON u.id = s.user_id
      LEFT JOIN public.profiles p ON p.id = u.id
     WHERE p_token_hash IS NOT NULL
       AND s.token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND (p_user_id IS NULL OR s.user_id = p_user_id)
    UNION ALL
    SELECT u.id,
           coalesce(p.email::text, u.email::text),
           coalesce(
             nullif(btrim(p.display_name), ''),
             nullif(split_part(coalesce(p.email::text, u.email::text, ''), '@', 1), ''),
             'user'
           )
      FROM auth.users u
      LEFT JOIN public.profiles p ON p.id = u.id
     WHERE p_token_hash IS NULL
       AND p_user_id IS NOT NULL
       AND u.id = p_user_id
  ),
  member AS (
    SELECT m.org_id AS live_org_id, m.role::text AS role
      FROM sess
      JOIN public.org_members m ON m.user_id = sess.user_id AND m.status = 'active'
      JOIN public.organizations o ON o.id = m.org_id AND o.environment = 'live'
     WHERE m.org_id::text = p_preferred_org
     ORDER BY m.created_at
     LIMIT 1
  ),
  staff AS (
    SELECT CASE
             WHEN p_env = 'sandbox' THEN
               (SELECT sb.id
                  FROM public.organizations sb
                 WHERE sb.live_org_id = member.live_org_id
                   AND sb.environment = 'sandbox'
                 ORDER BY sb.created_at
                 LIMIT 1)
             WHEN p_env = 'live' THEN member.live_org_id
           END AS org_id
      FROM member
     WHERE member.role IN ('admin', 'manager')
  )
  SELECT sess.user_id,
         sess.viewer_name,
         sess.email,
         o.name,
         c.display_name,
         c.id,
         d.org_id,
         d.id,
         CASE WHEN d.org_id IS NOT DISTINCT FROM staff.org_id THEN 'staff' ELSE 'tenant' END,
         d.encryption_key_ref,
         (SELECT coalesce(array_agg(ph.slot ORDER BY ph.slot), '{}')
            FROM public.identity_document_photos ph
           WHERE ph.document_id = d.id)
    FROM sess
    JOIN public.identity_documents d ON d.id = p_document_id AND d.deleted_at IS NULL
    JOIN public.contacts c ON c.id = d.contact_id
    JOIN public.organizations o ON o.id = d.org_id
    LEFT JOIN staff ON true
   WHERE p_env IN ('live', 'sandbox')
     AND p_preferred_org IS NOT NULL
     AND o.environment::text = p_env
     AND (CASE WHEN p_env = 'live' THEN o.id::text = p_preferred_org
               ELSE o.live_org_id::text = p_preferred_org END)
     AND public.id_document_delete_after(d.lease_id, d.org_id, d.created_at) > (timezone('Asia/Taipei',now()))::date
     AND app.b002_retention_origin_known(d.lease_id, d.org_id)
     AND (d.org_id IS NOT DISTINCT FROM staff.org_id OR c.user_id = sess.user_id)
$$;

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
            d.deleted_at IS NULL AND public.id_document_delete_after(d.lease_id, d.org_id, d.created_at) <= (timezone('Asia/Taipei',now()))::date
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
DECLARE
  v_enabled jsonb;
BEGIN
  SELECT value INTO v_enabled FROM public.platform_settings
   WHERE key = 'ID_PURGE_ENABLED' FOR SHARE;
  IF v_enabled IS DISTINCT FROM '"on"'::jsonb THEN
    RAISE EXCEPTION 'ID purge is disabled' USING ERRCODE = '42501';
  END IF;

  DROP TABLE IF EXISTS pg_temp.id_purge_batch;
  DROP TABLE IF EXISTS pg_temp.b002_locked_leases;
  CREATE TEMP TABLE b002_locked_leases (id uuid PRIMARY KEY) ON COMMIT DROP;
  -- Corrections lock lease then document. Acquire the same order; a busy
  -- lease is deferred rather than allowing a stale retention decision.
  INSERT INTO pg_temp.b002_locked_leases
  SELECT l.id FROM public.leases l
   WHERE EXISTS (
     SELECT 1 FROM public.identity_documents d
      WHERE d.lease_id=l.id AND d.org_id=l.org_id AND (
        (d.deleted_at IS NULL AND public.id_document_delete_after(d.lease_id,d.org_id,d.created_at) <= (timezone('Asia/Taipei',now()))::date)
        OR (d.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.identity_document_photos p WHERE p.document_id=d.id))
      )
   )
   ORDER BY l.id
   LIMIT greatest(1, least(1000, coalesce(p_limit, 500)))
   FOR SHARE OF l SKIP LOCKED;

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
   WHERE (d.lease_id IS NULL OR EXISTS (SELECT 1 FROM pg_temp.b002_locked_leases l WHERE l.id=d.lease_id))
     AND (
          d.deleted_at IS NULL AND public.id_document_delete_after(d.lease_id, d.org_id, d.created_at) <= (timezone('Asia/Taipei',now()))::date
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

  -- This statement gets a fresh READ COMMITTED snapshot after both locks.
  -- Lease locks prevent later corrections until the transaction completes.
  DELETE FROM pg_temp.id_purge_batch b WHERE NOT EXISTS (
    SELECT 1 FROM public.identity_documents d WHERE d.id=b.document_id AND (
      (d.deleted_at IS NULL AND public.id_document_delete_after(d.lease_id,d.org_id,d.created_at) <= (timezone('Asia/Taipei',now()))::date)
      OR (d.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.identity_document_photos p WHERE p.document_id=d.id))
    )
  );

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

REVOKE ALL ON FUNCTION public.id_document_delete_after(uuid, uuid, timestamptz),
  public.id_photo_gate(text, uuid, uuid, text, text), public.preview_due_identity_documents(integer),
  public.purge_due_identity_documents(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.id_document_delete_after(uuid, uuid, timestamptz),
  public.id_photo_gate(text, uuid, uuid, text, text), public.preview_due_identity_documents(integer),
  public.purge_due_identity_documents(integer) TO service_role;

COMMIT;
