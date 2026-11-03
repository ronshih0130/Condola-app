import { writeSignedPdfDownload } from '@/server/audit';
import { requireCurrentConsent } from '@/server/consent-gate';
import { logServerError } from '@/server/errors';
import { getSession } from '@/server/session';
import { TENANT_SIGNED_PDF_ENABLED } from '@/server/tenant-signed-pdf-rules';
import { signedPdfPrivateHeaders, tenantSignedPdfDownload } from '@/server/tenant-signed-pdf-download';
import { tenantEndedLeaseSignedPdf } from '@/server/tenant-lease-history';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function missing() { return new Response('Not found', { status: 404, headers: signedPdfPrivateHeaders }); }
export async function GET(_request: Request, { params }: { params: Promise<{ leaseId: string; pdfId: string }> }) {
  const session = await getSession();
  const blocked = await requireCurrentConsent(session, 'api');
  if (blocked) return blocked;
  if (session.kind !== 'tenant') return missing();
  const { leaseId, pdfId } = await params;
  if (!TENANT_SIGNED_PDF_ENABLED || !uuid.test(leaseId) || !uuid.test(pdfId)) return missing();
  try {
    return await tenantSignedPdfDownload({ orgId: session.orgId, userId: session.userId, leaseId, pdfId, requestId: crypto.randomUUID() }, {
      read: () => tenantEndedLeaseSignedPdf(session, leaseId, pdfId),
      audit: writeSignedPdfDownload,
      logError: logServerError,
    });
  } catch (error) {
    logServerError('tenant_ended_signed_pdf', error);
    return new Response('Unavailable', { status: 503, headers: signedPdfPrivateHeaders });
  }
}
