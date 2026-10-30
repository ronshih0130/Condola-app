import { requireCurrentConsent } from "./consent-gate";
import { authorizePayeeAction, authorizePayeeApi } from "./payee-action-context";
import { logPayeeIngress, readPayeeContext } from "./payee";
import { readSession } from "./session";

/** Fixed server-owned adapters; callers cannot supply authorization dependencies. */
export async function authorizePayeeActionEntry() {
  return authorizePayeeAction({ readSession, readContext: readPayeeContext, audit: logPayeeIngress,
    requireConsent: (session) => requireCurrentConsent(session) });
}

export async function authorizePayeeApiEntry() {
  return authorizePayeeApi({ readSession, readContext: readPayeeContext, audit: logPayeeIngress,
    requireConsent: (session) => requireCurrentConsent(session, "api") });
}
