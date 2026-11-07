import { many, maybe, svc } from './db';
import { requireOrgScope } from './org-guard';
import { can } from './perms';
import type { Session } from './types';
import { authorizeVendorStaff } from './vendor-onboarding';
import { vendorDocumentsEnabled } from './vendor-document-admission';

export type { DocumentInviteView } from '@/lib/vendor-document-ui';
import type { DocumentInviteView } from '@/lib/vendor-document-ui';

/** Only safe metadata, never token hashes or buyer/company settlement data. */
export async function vendorDocumentInvitesView(session: Session, ticketId: string): Promise<DocumentInviteView | null> {
  requireOrgScope(session);
  if (session.kind !== 'staff' || !can(session.role, 'tickets.update')) return null;
  return svc(session.userId, async (client) => {
    if (!await vendorDocumentsEnabled(client, session.orgId)) return null;
    await authorizeVendorStaff(client, session);
    const ticket = await maybe<{ property_id: string; status: string; profile_id: string | null; vendor_name: string | null; live_job: boolean }>(client,
      `SELECT t.property_id,t.status,p.id AS profile_id,p.display_name AS vendor_name,
       EXISTS(SELECT 1 FROM repair_vendor_jobs j WHERE j.org_id=t.org_id AND j.ticket_id=t.id AND j.active AND j.revoked_at IS NULL) AS live_job
       FROM maintenance_tickets t LEFT JOIN vendor_profiles p ON p.org_id=t.org_id AND p.contact_id=t.assigned_vendor_contact_id
       WHERE t.id=$1 AND t.org_id=$2`, [ticketId, session.orgId]);
    if (!ticket) return null;
    const owners = await many<{ id: string; name: string }>(client,
      `SELECT DISTINCT c.id::text,c.display_name AS name FROM property_owners po
       JOIN contacts c ON c.id=po.owner_contact_id AND c.org_id=po.org_id
       WHERE po.org_id=$1 AND po.property_id=$2 AND c.is_owner AND c.archived_at IS NULL
       AND po.effective_from<=current_date AND (po.effective_to IS NULL OR po.effective_to>=current_date)
       ORDER BY name,id`, [session.orgId, ticket.property_id]);
    const invites = await many<DocumentInviteView['invites'][number]>(client,
      `SELECT id::text,expires_at::text AS "expiresAt", CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
       WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END AS state
       FROM vendor_document_grants WHERE org_id=$1 AND ticket_id=$2 ORDER BY created_at DESC,id`, [session.orgId, ticketId]);
    return { profileId: ticket.profile_id, vendorName: ticket.vendor_name,
      ready: ticket.status === 'closed' && ticket.live_job && !!ticket.profile_id, owners, invites };
  });
}
