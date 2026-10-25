-- Version 20261029130000.
-- Managers must not UPDATE or DELETE identity rows through PostgREST.
-- iddoc_team was FOR ALL, so an admin or manager JWT could change or remove
-- identity_documents directly. Replace it with a SELECT policy. REVOKE
-- UPDATE and DELETE from PUBLIC, anon, and authenticated on the id tables.
-- service_role keeps those privileges. The app writes through service_role
-- and the SECURITY DEFINER functions below. No new NOT NULL or constraint.
--
-- Photo view and photo bytes are one function call each. No SET LOCAL ROLE
-- and no explicit transaction on that read. Audit inserts are id_photo_record,
-- one statement, called after the response.
--
-- Retention stays id_document_keep_days() = 90. A lease that took effect is
-- deleted 90 days after it ends. A lease that never took effect is deleted
-- 90 days after the Taipei upload date. purge_due_identity_documents removes
-- the live ciphertext. Supabase backup snapshots are outside this database
-- and must age out within 14 days. See docs/STAGING.md.

DROP POLICY IF EXISTS iddoc_team ON public.identity_documents;
DROP POLICY IF EXISTS iddoc_team_select ON public.identity_documents;
CREATE POLICY iddoc_team_select ON public.identity_documents
  FOR SELECT TO authenticated
  USING (app.has_role(org_id, '{admin,manager}'::public.org_role[]));

REVOKE UPDATE, DELETE ON TABLE
  public.identity_documents,
  public.identity_document_photos,
  public.identity_document_access_log,
  public.id_document_objects,
  public.id_upload_slots
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT ON TABLE public.identity_documents TO authenticated;
GRANT SELECT ON TABLE public.identity_document_photos TO authenticated;
GRANT SELECT ON TABLE public.identity_document_access_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.identity_documents,
  public.identity_document_photos,
  public.identity_document_access_log,
  public.id_document_objects,
  public.id_upload_slots
TO service_role;

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
     ORDER BY CASE WHEN p_preferred_org IS NOT NULL AND m.org_id::text = p_preferred_org THEN 0 ELSE 1 END,
              m.created_at
     LIMIT 1
  ),
  staff AS (
    SELECT CASE
             WHEN p_env = 'sandbox' THEN coalesce(
               (SELECT sb.id
                  FROM public.organizations sb
                 WHERE sb.live_org_id = member.live_org_id
                   AND sb.environment = 'sandbox'
                 ORDER BY sb.created_at
                 LIMIT 1),
               member.live_org_id)
             ELSE member.live_org_id
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
   WHERE d.org_id IS NOT DISTINCT FROM staff.org_id
      OR c.user_id = sess.user_id
$$;

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
         obj.mime_type,
         g.encryption_key_ref,
         octet_length(obj.ciphertext)::integer,
         gs.i,
         substring(obj.ciphertext FROM gs.i FOR 24576)
    FROM public.id_photo_gate(p_token_hash, p_user_id, p_document_id, p_preferred_org, p_env) AS g
    JOIN public.identity_document_photos ph
      ON ph.document_id = g.document_id AND ph.slot = p_slot
    JOIN public.id_document_objects obj
      ON obj.bucket = ph.storage_bucket AND obj.path = ph.storage_path
    CROSS JOIN LATERAL generate_series(1, octet_length(obj.ciphertext), 24576) AS gs(i)
   ORDER BY gs.i
$$;

CREATE OR REPLACE FUNCTION public.id_photo_record(
  p_org_id uuid,
  p_document_id uuid,
  p_user_id uuid,
  p_purpose text,
  p_expires timestamptz,
  p_slot text,
  p_contact_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.identity_document_access_log (org_id, document_id, accessed_by, purpose, signed_url_expires_at)
  VALUES (p_org_id, p_document_id, p_user_id, p_purpose, p_expires);

  INSERT INTO public.audit_log (
    org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, new_row, reason
  ) VALUES (
    p_org_id,
    p_user_id,
    'app',
    'identity_documents',
    p_document_id::text,
    'insert',
    CASE WHEN p_purpose = 'download' THEN 'id_document_download' ELSE 'id_document_view' END,
    CASE
      WHEN p_purpose = 'download' THEN jsonb_build_object('documentId', p_document_id, 'slot', p_slot)
      ELSE jsonb_build_object('documentId', p_document_id, 'contactId', p_contact_id, 'purpose', p_purpose)
    END,
    CASE WHEN p_purpose = 'download' THEN NULL ELSE p_purpose END
  );
END $$;

REVOKE ALL ON FUNCTION public.id_photo_gate(text, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.id_photo_open(text, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.id_photo_record(uuid, uuid, uuid, text, timestamptz, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.id_photo_gate(text, uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.id_photo_open(text, uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.id_photo_record(uuid, uuid, uuid, text, timestamptz, text, uuid) TO service_role;

COMMENT ON FUNCTION public.id_document_keep_days() IS
  '90 days. A lease that took effect is deleted this many days after it ends. A lease that never took effect is deleted this many days after the Taipei upload date. Live ciphertext is removed by purge_due_identity_documents. Supabase backups are outside the app and must be retained at most 14 days.';

COMMENT ON FUNCTION public.purge_due_identity_documents(integer) IS
  'Deletes live ID photo bytes once delete_after has passed (lease end + 90 days, or upload + 90 days when the lease never took effect). Does not delete Supabase backup snapshots; those must age out within 14 days.';
