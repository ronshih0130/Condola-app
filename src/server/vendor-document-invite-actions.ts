'use server';
import { requireCurrentConsent } from './consent-gate';
import { getSession } from './session';
import { requireOrgScope } from './org-guard';
import { isUuid } from './repair-rules';
import { createVendorDocumentInvite, revokeVendorDocumentInvite } from './vendor-receipt';
import type { VendorBuyerSelection } from './vendor-receipt';

export async function actionCreateVendorDocumentInvite(input: { ticketId: string; profileId: string; buyer: VendorBuyerSelection }) {
  await requireCurrentConsent();
  const session = await getSession();
  requireOrgScope(session);
  if (!input || !isUuid(input.ticketId) || !isUuid(input.profileId) || !input.buyer
    || !['owner', 'company'].includes(input.buyer.kind)
    || (input.buyer.kind === 'owner' && !isUuid(input.buyer.contactId))) return { ok: false as const };
  try {
    const invite = await createVendorDocumentInvite(session, input.ticketId, input.profileId, input.buyer, { documentUi: true });
    return { ok: true as const, ...invite };
  } catch { return { ok: false as const }; }
}

export async function actionRevokeVendorDocumentInvite(grantId: string) {
  await requireCurrentConsent();
  const session = await getSession();
  requireOrgScope(session);
  if (!isUuid(grantId)) return { ok: false as const };
  try {
    await revokeVendorDocumentInvite(session, grantId, { documentUi: true });
    return { ok: true as const };
  } catch { return { ok: false as const }; }
}
