import type { ReactNode } from 'react';
import { requireCurrentConsent } from '@/server/consent-gate';
import { getSession } from '@/server/session';
import { isUuid } from '@/server/repair-rules';
import { vendorDocumentInvitesView } from '@/server/vendor-document-invites';
import { VendorDocumentInvites } from '@/components/vendor-document-invites';

export const dynamic = 'force-dynamic';

export default async function TicketDocumentLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  await requireCurrentConsent(undefined, 'page');
  const session = await getSession();
  const { id } = await params;
  if (!isUuid(id)) return children;
  const view = await vendorDocumentInvitesView(session, id);
  if (!view) return children;
  return <>{children}<VendorDocumentInvites ticketId={id} view={view} locale={session.locale} /></>;
}
