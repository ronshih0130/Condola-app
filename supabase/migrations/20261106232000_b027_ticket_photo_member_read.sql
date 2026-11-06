-- B-027 BLK-MAC-12 (GAP-01 / GAP-02): ticket-photo metadata and legacy inline
-- attachment bytes are readable through member RLS only by roles that hold
-- tickets.update (admin, manager, maintenance; src/server/perms.ts). Accountant
-- keeps every non-photo file, its own uploads (portal_files_own_read) and a
-- photo COUNT through a narrow definer function, so the existing no-permission
-- notice still renders. Tenant (non-member) portal access is unchanged.
-- Additive: policy replacements + one new function; no table/column/flag change.

-- Context-independent org membership: app.is_member() is pinned to the
-- session's org/environment settings and returns FALSE on a mismatched pin, so
-- NOT app.is_member() cannot prove non-membership. Any org_members row for the
-- org (or its live org), in any status, marks the caller as staff, never as a
-- portal user (genuine tenants have no org_members rows).
CREATE FUNCTION app.b027_any_org_member(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_members m
      JOIN public.organizations o ON o.id = p_org
     WHERE m.user_id = auth.uid() AND (m.org_id = p_org OR m.org_id = o.live_org_id))
$$;
REVOKE ALL ON FUNCTION app.b027_any_org_member(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b027_any_org_member(uuid) TO authenticated;

-- GAP-01: files metadata. Ticket photos (and other private repair objects) live
-- in the private ticket-photos bucket; key on the bucket, not on an RLS-filtered
-- ticket_attachments subquery (which would re-open the row once hidden).
DROP POLICY IF EXISTS team_read ON public.files;
CREATE POLICY team_read ON public.files FOR SELECT TO authenticated
  USING (app.is_member(org_id) AND (
    storage_bucket IS DISTINCT FROM 'ticket-photos-private'
    OR app.has_role(org_id, '{admin,manager,maintenance}'::org_role[])
  ));

-- Writes must not re-open GAP-01: an Accountant UPDATE (e.g. SET uploaded_by =
-- auth.uid() without WHERE/RETURNING needs no SELECT) followed by the own-upload
-- read. Photo-bucket rows are writable only by tickets.update roles, checked on
-- both the existing row (USING) and the resulting row (WITH CHECK).
DROP POLICY IF EXISTS team_update ON public.files;
CREATE POLICY team_update ON public.files FOR UPDATE TO authenticated
  USING (app.has_role(org_id, '{admin,manager,accountant,maintenance}'::org_role[]) AND (
    storage_bucket IS DISTINCT FROM 'ticket-photos-private'
    OR app.has_role(org_id, '{admin,manager,maintenance}'::org_role[])))
  WITH CHECK (app.has_role(org_id, '{admin,manager,accountant,maintenance}'::org_role[]) AND (
    storage_bucket IS DISTINCT FROM 'ticket-photos-private'
    OR app.has_role(org_id, '{admin,manager,maintenance}'::org_role[])));
DROP POLICY IF EXISTS team_delete ON public.files;
CREATE POLICY team_delete ON public.files FOR DELETE TO authenticated
  USING (app.has_role(org_id, '{admin,manager,accountant,maintenance}'::org_role[]) AND (
    storage_bucket IS DISTINCT FROM 'ticket-photos-private'
    OR app.has_role(org_id, '{admin,manager,maintenance}'::org_role[])));

-- Own uploads: a current org member's access follows the member role, not
-- upload history; non-members (tenant portal uploaders) keep their own rows.
DROP POLICY IF EXISTS portal_files_own_read ON public.files;
CREATE POLICY portal_files_own_read ON public.files FOR SELECT TO authenticated
  USING (uploaded_by = auth.uid() AND (
    storage_bucket IS DISTINCT FROM 'ticket-photos-private'
    OR NOT app.b027_any_org_member(org_id)
    OR app.has_role(org_id, '{admin,manager,maintenance}'::org_role[])));

-- Portal photo metadata: tenant_owns_ticket() is also TRUE for a staff reporter
-- (reported_by_user), so restrict the portal path to non-members; members are
-- governed by team_read above.
DROP POLICY IF EXISTS portal_ticket_photo_read ON public.files;
CREATE POLICY portal_ticket_photo_read ON public.files FOR SELECT TO authenticated
  USING (storage_bucket = 'ticket-photos-private' AND NOT app.b027_any_org_member(org_id) AND EXISTS (
    SELECT 1 FROM public.ticket_attachments a
     WHERE a.file_id = files.id AND a.org_id = files.org_id AND NOT a.is_internal
       AND app.tenant_owns_ticket(a.ticket_id)));

-- GAP-02: ticket_attachments rows (incl. legacy inline content) for members.
DROP POLICY IF EXISTS team_read ON public.ticket_attachments;
CREATE POLICY team_read ON public.ticket_attachments FOR SELECT TO authenticated
  USING (app.has_role(org_id, '{admin,manager,maintenance}'::org_role[]));

-- The portal policy used app.can_see_ticket, which is TRUE for any member and
-- re-admitted Accountant; app.tenant_owns_ticket is also TRUE for a staff
-- reporter. Members are governed by team_read above, so the portal policy
-- admits non-members only.
DROP POLICY IF EXISTS portal_ticket_att_read ON public.ticket_attachments;
CREATE POLICY portal_ticket_att_read ON public.ticket_attachments FOR SELECT TO authenticated
  USING ((NOT is_internal) AND NOT app.b027_any_org_member(org_id) AND app.tenant_owns_ticket(ticket_id));

-- Photo count for members without photo access (no ids, names or bytes).
CREATE FUNCTION app.b027_ticket_attachment_count(p_ticket uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT count(*)::integer FROM public.ticket_attachments a
    JOIN public.maintenance_tickets t ON t.id=a.ticket_id AND t.org_id=a.org_id
   WHERE a.ticket_id=p_ticket AND app.is_member(t.org_id)
$$;
REVOKE ALL ON FUNCTION app.b027_ticket_attachment_count(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b027_ticket_attachment_count(uuid) TO authenticated;
