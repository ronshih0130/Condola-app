BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

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
  WITH args AS (
    SELECT nullif(p_preferred_org, '') AS preferred_org,
           nullif(p_env, '') AS env
  ),
  sess AS (
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
      CROSS JOIN args
     WHERE m.org_id::text = coalesce(
       args.preferred_org,
       (SELECT d.org_id::text
          FROM public.identity_documents d
         WHERE d.id = p_document_id AND d.deleted_at IS NULL)
     )
     ORDER BY m.created_at
     LIMIT 1
  ),
  staff AS (
    SELECT CASE
             WHEN args.env = 'sandbox' THEN
               (SELECT sb.id
                  FROM public.organizations sb
                 WHERE sb.live_org_id = member.live_org_id
                   AND sb.environment = 'sandbox'
                 ORDER BY sb.created_at
                 LIMIT 1)
             WHEN args.env IS NULL OR args.env = 'live' THEN member.live_org_id
           END AS org_id
      FROM member
      CROSS JOIN args
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
    CROSS JOIN args
    LEFT JOIN staff ON true
   WHERE coalesce(args.env, 'live') IN ('live', 'sandbox')
     AND o.environment::text = coalesce(args.env, 'live')
     AND (args.preferred_org IS NULL OR
          CASE WHEN o.environment = 'live' THEN o.id::text = args.preferred_org
               WHEN o.environment = 'sandbox' THEN o.live_org_id::text = args.preferred_org
               ELSE false END)
     AND public.id_document_delete_after(d.lease_id, d.org_id, d.created_at) > (timezone('Asia/Taipei',now()))::date
     AND app.b002_retention_origin_known(d.lease_id, d.org_id)
     AND (d.org_id IS NOT DISTINCT FROM staff.org_id OR c.user_id = sess.user_id)
$$;

REVOKE ALL ON FUNCTION public.id_photo_gate(text, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.id_photo_gate(text, uuid, uuid, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION app.b002_capture_end_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.id_retention_auto_end := NEW.status IN ('terminated','cancelled') AND NEW.end_date IS NULL;
  ELSE
    NEW.id_retention_auto_end := OLD.id_retention_auto_end;
    IF OLD.end_date IS NULL AND NEW.end_date IS NULL AND NEW.status IN ('terminated','cancelled') THEN
      NEW.id_retention_auto_end := true;
    ELSIF OLD.id_retention_auto_end IS NULL
      AND NEW.end_date IS NOT NULL
      AND NEW.end_date IS DISTINCT FROM OLD.end_date THEN
      NEW.id_retention_auto_end := false;
    ELSIF OLD.id_retention_auto_end IS NULL
      AND OLD.status = 'active' AND NEW.status = 'active'
      AND OLD.end_date IS NULL AND NEW.end_date IS NULL
      AND OLD.terminated_on IS NULL AND NEW.terminated_on IS NULL
      AND OLD.moved_out_on IS NULL AND NEW.moved_out_on IS NOT NULL THEN
      NEW.id_retention_auto_end := false;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Serialize the provenance backfill with lease writes. Only this trigger is
-- suspended; all other lease guards remain enabled. Transaction rollback also
-- restores the trigger if the update fails or exceeds either timeout.
ALTER TABLE public.leases DISABLE TRIGGER aaa_b002_capture_end_origin;

-- The close trigger only manufactures dates for terminated/cancelled rows.
-- Reconcile formed fixed-term rows outside those states only when there is
-- no termination marker. A move-out does not manufacture an end_date and
-- therefore does not disqualify an otherwise fixed-term row.
-- Keep closed/termination-marked and open-ended historical rows unknown.
UPDATE public.leases
   SET id_retention_auto_end = false
 WHERE id_retention_auto_end IS NULL
   AND end_date IS NOT NULL
   AND terminated_on IS NULL
   AND status NOT IN ('terminated', 'cancelled', 'draft')
   AND esign_status NOT IN ('voided', 'declined')
   AND (status IN ('active', 'ended')
        OR signed_at IS NOT NULL OR esign_status = 'fully_signed');

ALTER TABLE public.leases ENABLE TRIGGER aaa_b002_capture_end_origin;

COMMIT;
