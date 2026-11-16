import type { TopupInput, TopupResult } from "../../../server/mf3-deposit-topup";

/**
 * MO-TOPUP sheet state and submission, kept free of React so the stateful rules are unit tested
 * (MGT-151-AC3/AC5). TopupSheet is only the wiring around these two pieces.
 *
 * One request key per unsaved entry: it is made when the sheet opens on a new entry and kept through
 * failures, edits, closing and reopening, until the entry saves. A reply that was lost after the
 * server recorded the entry therefore can never lead to a second record: resending (edited or not)
 * either replays the same row or answers `conflict`, which means the earlier save landed. Only a
 * save, or an `invalid` answer (nothing was recorded), starts a new key.
 */
export type TopupSheetState = {
  open: boolean; amount: string; date: string; note: string; saving: boolean;
  /** The last save attempt did not save: GS-02 「沒有存成功，請再試一次。」 + 「再試一次」, input kept. */
  failed: boolean;
  /** The pending entry's request key; null when no entry is pending. */
  key: string | null;
};
/** saved: recorded or replayed. landed: an earlier attempt with this key was recorded (conflict). */
export type TopupOutcome = "saved" | "landed" | "retry" | "invalid";
export type TopupSheetAction =
  | { type: "open"; today: string; key: string }
  | { type: "close" }
  | { type: "edit"; field: "amount" | "date" | "note"; value: string }
  | { type: "start" }
  /** Input the sheet refuses before sending (above the cap, a future date): nothing was sent. */
  | { type: "refused" }
  | { type: "done"; outcome: TopupOutcome };

export const closedSheet: TopupSheetState = { open: false, amount: "", date: "", note: "", saving: false, failed: false, key: null };

export function topupSheetReducer(state: TopupSheetState, action: TopupSheetAction): TopupSheetState {
  switch (action.type) {
    case "open":
      // A pending entry (key set) reopens as it was, with the same key; otherwise a new entry gets the new key.
      return state.key ? { ...state, open: true, saving: false } : { ...closedSheet, open: true, date: action.today, key: action.key };
    case "close":
      return state.saving ? state : { ...state, open: false };
    case "edit":
      return state.saving ? state : { ...state, [action.field]: action.value };
    case "start":
      return { ...state, saving: true, failed: false };
    case "refused":
      return { ...state, saving: false, failed: true };
    case "done":
      if (action.outcome === "saved" || action.outcome === "landed") return closedSheet;
      // Every other outcome keeps the key, including `invalid`: the gateway validates before it looks the key up, so an
      // earlier attempt with this key may already have landed. Reusing it means the next send records once or answers conflict.
      return { ...state, saving: false, failed: true };
  }
}

export type TopupContent = { amountMinor: string; receivedOn: string; note: string | null };
type Target = { leaseId: string; settlementId: string };

/** Sends one attempt with the entry's key. A second send while one is in flight is refused ("busy"). */
export function createTopupSender(submit: (input: TopupInput) => Promise<TopupResult>) {
  let inflight = false;
  return {
    get busy() { return inflight; },
    async send(target: Target, key: string, content: TopupContent): Promise<TopupOutcome | "busy"> {
      if (inflight) return "busy";
      inflight = true;
      let result: TopupResult;
      try {
        result = await submit({ ...target, requestId: key, amountMinor: content.amountMinor, receivedOn: content.receivedOn, note: content.note });
      } catch {
        result = { ok: false, reason: "failed" };
      } finally {
        inflight = false;
      }
      if (result.ok) return "saved";
      if (result.reason === "conflict") return "landed";
      if (result.reason === "invalid") return "invalid";
      return "retry";
    },
  };
}
