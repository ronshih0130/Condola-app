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
 *
 * MO-TOPUP-DUP (OQ-081): when `conflict` shows an earlier send with this key landed and the user had
 * changed a value since a send, the sheet closes, the page refreshes and the toast
 * 「這筆已經記錄過了，剛剛的修改沒有存。」 shows; nothing changed, nothing shows. 取消 on an entry that
 * was never sent clears it; an unconfirmed entry (sent, then failed) keeps its values and key.
 */
export type TopupSheetState = {
  open: boolean; amount: string; date: string; note: string; saving: boolean;
  /** The last save attempt did not save: GS-02 「沒有存成功，請再試一次。」 + 「再試一次」, input kept. */
  failed: boolean;
  /** The pending entry's request key; null when no entry is pending. */
  key: string | null;
  /** Signatures (topupSignature) of every send made with this key, oldest first; empty when never sent. */
  sent: string[];
  /** MO-TOPUP-DUP toast: shown after an edited entry turned out to be already recorded; cleared on open. */
  dupNotice: boolean;
};
/** saved: recorded or replayed. landed: an earlier attempt with this key was recorded (conflict). */
export type TopupOutcome = "saved" | "landed" | "retry" | "invalid";
export type TopupSheetAction =
  | { type: "open"; today: string; key: string }
  | { type: "close" }
  | { type: "edit"; field: "amount" | "date" | "note"; value: string }
  | { type: "start"; signature: string }
  /** Input the sheet refuses before sending (above the cap, a future date): nothing was sent. */
  | { type: "refused" }
  | { type: "done"; outcome: TopupOutcome };

export const closedSheet: TopupSheetState = { open: false, amount: "", date: "", note: "", saving: false, failed: false, key: null, sent: [], dupNotice: false };

/** The values the gateway compares for one key: amount, date and (trimmed) note. */
export function topupSignature(content: TopupContent): string {
  return JSON.stringify([content.amountMinor, content.receivedOn, content.note?.trim() || null]);
}

export function topupSheetReducer(state: TopupSheetState, action: TopupSheetAction): TopupSheetState {
  switch (action.type) {
    case "open":
      // A pending entry (key set) reopens as it was, with the same key; otherwise a new entry gets the new key.
      // Opening the sheet again also dismisses the MO-TOPUP-DUP toast.
      return state.key ? { ...state, open: true, saving: false, dupNotice: false }
        : { ...closedSheet, open: true, date: action.today, key: action.key };
    case "close":
      if (state.saving) return state;
      // Never sent: nothing can have landed, so 取消 clears the entry and its key. Sent and unconfirmed: keep both.
      return state.sent.length ? { ...state, open: false } : closedSheet;
    case "edit":
      return state.saving ? state : { ...state, [action.field]: action.value };
    case "start":
      return { ...state, saving: true, failed: false, sent: [...state.sent, action.signature] };
    case "refused":
      return { ...state, saving: false, failed: true };
    case "done":
      if (action.outcome === "saved") return closedSheet;
      if (action.outcome === "landed") {
        // conflict: an earlier send with this key landed. Edited = some earlier send differs from the last one.
        const last = state.sent[state.sent.length - 1];
        return { ...closedSheet, dupNotice: state.sent.slice(0, -1).some(signature => signature !== last) };
      }
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
