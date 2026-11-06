import { requireCurrentConsent } from "@/server/consent-gate";
import { logServerError } from "@/server/errors";
import { openOwnerDocument, ownerPortalExtensionsOn } from "@/server/owner-portal-access";
import { ownerDocumentHeadHttp, ownerDocumentHttp, ownerDocumentNotFound } from "@/server/owner-portal-access-http";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** B-023 authorized owner document open (`?view=1` inline, else download). Flag OFF ⇒ 404, no write. */
export async function GET(request: Request, context: { params: Promise<{ documentId: string }> }) {
  const session = await getSession();
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  if (session.kind !== "owner") return ownerDocumentNotFound();
  const { documentId } = await context.params;
  return ownerDocumentHttp({
    documentId,
    url: request.url,
    open: (kind, requestId) => openOwnerDocument(session, documentId, kind, requestId),
    logError: (error) => logServerError("owner_document_open", error),
  });
}

/** HEAD: no document read, no access row. Flag OFF ⇒ 404, otherwise 405. */
export async function HEAD() {
  const session = await getSession();
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  return ownerDocumentHeadHttp({ enabled: () => ownerPortalExtensionsOn(session) });
}
