"use server";

import { saveOwnerView, type OwnerViewSaveResult } from "./b073-owner-view";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";

/**
 * B-073 / R5-OWNVIEW (MGT-138): each switch saves on change and gets a result back (no redirect). saveOwnerView
 * applies the settings.edit guard first; a non-admin gets `{ ok: false, status: 403 }` (MGT-138-AC3).
 */
export async function saveOwnerViewAction(input: unknown): Promise<OwnerViewSaveResult> {
  await requireCurrentConsent();
  return saveOwnerView(await getSession(), input);
}
