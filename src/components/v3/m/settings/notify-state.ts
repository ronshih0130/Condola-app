import type { NotifyBlock, NotifyField, NotifyToggles } from "../../../../server/b073-notify-settings";

/**
 * R5-NOTIFY switch state for one block (MGT-135-AC5). Pure: no server or React imports. `saved` is what the server
 * stored; `shown` is what the switches draw. One save at a time per block; each save writes only its own key, and
 * the answer carries the stored state of that block.
 */
export type NotifyState = { saved: NotifyToggles; shown: NotifyToggles; saving: NotifyField | null; error: boolean };
export type NotifyOutcome = { ok: true; toggles: NotifyToggles } | { ok: false; status: number } | "threw";
export const NOTIFY_API = "/api/notify-settings";

/** POST one switch. Any non-2xx (403 included), another block's answer or a malformed body fails; a network error is "threw". */
export async function postNotify(block: NotifyBlock, field: NotifyField, value: boolean, fetcher: typeof fetch = fetch): Promise<NotifyOutcome> {
  let response: Response;
  try {
    response = await fetcher(NOTIFY_API, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ block, field, value }) });
  } catch { return "threw"; }
  if (!response.ok) return { ok: false, status: response.status };
  try {
    const body = await response.json() as { block?: unknown; toggles?: { leaseExpiry?: unknown; rentOverdue?: unknown } };
    const toggles = body?.toggles;
    if (body?.block === block && toggles && typeof toggles.leaseExpiry === "boolean" && typeof toggles.rentOverdue === "boolean")
      return { ok: true, toggles: { leaseExpiry: toggles.leaseExpiry, rentOverdue: toggles.rentOverdue } };
  } catch { /* malformed */ }
  return { ok: false, status: response.status };
}

export function initialNotifyState(toggles: NotifyToggles): NotifyState {
  return { saved: { ...toggles }, shown: { ...toggles }, saving: null, error: false };
}
/** A tap flips the switch at once and starts its save; while a save in this block runs, a tap does nothing (null). */
export function startNotifyToggle(state: NotifyState, field: NotifyField): NotifyState | null {
  if (state.saving) return null;
  return { saved: state.saved, shown: { ...state.saved, [field]: !state.saved[field] }, saving: field, error: false };
}
/** Success stores what the server answered; any failure returns the switch to its saved value, with the error line. */
export function afterNotifySave(state: NotifyState, outcome: NotifyOutcome): NotifyState {
  if (outcome !== "threw" && outcome.ok) return { saved: { ...outcome.toggles }, shown: { ...outcome.toggles }, saving: null, error: false };
  return { saved: state.saved, shown: { ...state.saved }, saving: null, error: true };
}
/** Newer server props (after a navigation) replace the local values only while nothing is saving. */
export function syncNotify(state: NotifyState, toggles: NotifyToggles): NotifyState {
  if (state.saving || (state.saved.leaseExpiry === toggles.leaseExpiry && state.saved.rentOverdue === toggles.rentOverdue)) return state;
  return initialNotifyState(toggles);
}
