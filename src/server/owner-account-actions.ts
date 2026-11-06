"use server";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import {
  revokeOwnerSession, saveOwnerProfile, setOwnerNotificationPreference,
  type RevokeSessionInput, type SaveProfileInput, type SetPreferenceInput,
} from "./owner-account";

// B-023 slice 3 owner POSTs: Next server actions (same-origin enforced by Next),
// consent-gated first, idempotent by the client-held request id. Ownership and
// recent authentication are enforced again in SQL.
export async function revokeOwnerSessionAction(input: RevokeSessionInput) {
  await requireCurrentConsent();
  return revokeOwnerSession(await getSession(), input);
}
export async function saveOwnerProfileAction(input: SaveProfileInput) {
  await requireCurrentConsent();
  return saveOwnerProfile(await getSession(), input);
}
export async function setOwnerNotificationPreferenceAction(input: SetPreferenceInput) {
  await requireCurrentConsent();
  return setOwnerNotificationPreference(await getSession(), input);
}
