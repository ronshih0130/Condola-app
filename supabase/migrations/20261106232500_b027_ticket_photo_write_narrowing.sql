-- B-027 BLK-MAC-12 follow-up hardening (independent review MINORs on 20261106232000).
-- Additive policy replacements only; no table/column/flag change.

-- Members without tickets.update cannot create photo-bucket file rows.
DROP POLICY IF EXISTS team_insert ON public.files;
CREATE POLICY team_insert ON public.files FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, '{admin,manager,accountant,maintenance}'::org_role[]) AND (
    storage_bucket IS DISTINCT FROM 'ticket-photos-private'
    OR app.has_role(org_id, '{admin,manager,maintenance}'::org_role[])));

-- Portal uploads (files + attachment rows) are for non-members only: a staff
-- reporter (tenant_owns_ticket via reported_by_user) is not a portal user.
DROP POLICY IF EXISTS portal_files_insert ON public.files;
CREATE POLICY portal_files_insert ON public.files FOR INSERT TO authenticated
  WITH CHECK (uploaded_by = auth.uid() AND NOT app.b027_any_org_member(org_id) AND EXISTS (
    SELECT 1 FROM public.contacts c WHERE c.org_id = files.org_id AND c.user_id = auth.uid()));
DROP POLICY IF EXISTS portal_ticket_att_insert ON public.ticket_attachments;
CREATE POLICY portal_ticket_att_insert ON public.ticket_attachments FOR INSERT TO authenticated
  WITH CHECK ((NOT is_internal) AND NOT app.b027_any_org_member(org_id) AND app.tenant_owns_ticket(ticket_id) AND EXISTS (
    SELECT 1 FROM public.files f
     WHERE f.id = ticket_attachments.file_id AND f.org_id = ticket_attachments.org_id
       AND f.uploaded_by = auth.uid() AND f.storage_bucket = 'ticket-photos-private'));

-- Shared-photo attachment ids are photo metadata: tickets.update roles only
-- (all server readers use the service role).
DROP POLICY IF EXISTS repair_vendor_job_shared_photos_read ON public.repair_vendor_job_shared_photos;
CREATE POLICY repair_vendor_job_shared_photos_read ON public.repair_vendor_job_shared_photos FOR SELECT TO authenticated
  USING (app.has_role(org_id, '{admin,manager,maintenance}'::org_role[]));
