import type { OwnerViewField } from "../../../../server/b073-owner-view";
import type { OwnerPrivacy } from "../../../../server/privacy";

/**
 * R5-OWNVIEW switch state (MGT-138-AC4). Pure: no server or React imports. `saved` is what the server stored;
 * `shown` is what the switches draw. One save at a time for the whole block; each save writes only its own key,
 * and the answer carries the stored state of both.
 */
export type OwnerViewState = { saved: OwnerPrivacy; shown: OwnerPrivacy; saving: OwnerViewField | null; error: boolean };
export type OwnerViewOutcome = { ok: true; privacy: OwnerPrivacy } | { ok: false; status: number } | "threw";
export const OWNER_VIEW_API = "/api/owner-view";

/** POST one switch to /api/owner-view. Any non-2xx (403 included) or malformed answer is a failure; a network error is "threw". */
export async function postOwnerView(field: OwnerViewField, value: boolean, fetcher: typeof fetch = fetch): Promise<OwnerViewOutcome> {
  let response: Response;
  try {
    response = await fetcher(OWNER_VIEW_API, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ field, value }) });
  } catch { return "threw"; }
  if (!response.ok) return { ok: false, status: response.status };
  try {
    const body = await response.json() as { privacy?: { showName?: unknown; showPhone?: unknown } };
    const privacy = body?.privacy;
    if (privacy && typeof privacy.showName === "boolean" && typeof privacy.showPhone === "boolean")
      return { ok: true, privacy: { showName: privacy.showName, showPhone: privacy.showPhone } };
  } catch { /* malformed */ }
  return { ok: false, status: response.status };
}

export function initialOwnerViewState(privacy: OwnerPrivacy): OwnerViewState {
  return { saved: { ...privacy }, shown: { ...privacy }, saving: null, error: false };
}
/** A tap flips the switch at once and starts its save; while any save runs, a tap does nothing (null). */
export function startToggle(state: OwnerViewState, field: OwnerViewField): OwnerViewState | null {
  if (state.saving) return null;
  return { saved: state.saved, shown: { ...state.saved, [field]: !state.saved[field] }, saving: field, error: false };
}
/** Success stores what the server answered; any failure returns the switch to its saved value, with the error line. */
export function afterToggleSave(state: OwnerViewState, outcome: OwnerViewOutcome): OwnerViewState {
  if (outcome !== "threw" && outcome.ok) return { saved: { ...outcome.privacy }, shown: { ...outcome.privacy }, saving: null, error: false };
  return { saved: state.saved, shown: { ...state.saved }, saving: null, error: true };
}
/** Newer server props (after a navigation) replace the local values only while nothing is saving. */
export function syncOwnerView(state: OwnerViewState, privacy: OwnerPrivacy): OwnerViewState {
  if (state.saving || (state.saved.showName === privacy.showName && state.saved.showPhone === privacy.showPhone)) return state;
  return initialOwnerViewState(privacy);
}
