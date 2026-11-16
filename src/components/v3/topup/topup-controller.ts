import type { TopupInput, TopupResult } from "../../../server/mf3-deposit-topup";

/**
 * MO-TOPUP sheet state and submission, kept free of React so the stateful rules are unit tested
 * (MGT-151-AC3/AC5). TopupSheet is only the wiring around these two pieces.
 */
export type TopupError = "retry" | "fix";
export type TopupSheetState = {
  open: boolean; amount: string; date: string; note: string; saving: boolean;
  /** retry: send the same content again with the same key (「再試一次」). fix: the content must change first. */
  error: TopupError | null;
  /** The content on screen was sent and did not save; reopening keeps it. */
  unsaved: boolean;
};
export type TopupSheetAction =
  | { type: "open"; today: string }
  | { type: "close" }
  | { type: "edit"; field: "amount" | "date" | "note"; value: string }
  | { type: "start" }
  | { type: "done"; outcome: "saved" | TopupError };

export const closedSheet: TopupSheetState = { open: false, amount: "", date: "", note: "", saving: false, error: null, unsaved: false };

export function topupSheetReducer(state: TopupSheetState, action: TopupSheetAction): TopupSheetState {
  switch (action.type) {
    case "open":
      // After a failed save the typed entry survives closing and reopening the sheet.
      return state.unsaved ? { ...state, open: true, saving: false } : { ...closedSheet, open: true, date: action.today };
    case "close":
      return state.saving ? state : { ...state, open: false };
    case "edit":
      return state.saving ? state : { ...state, [action.field]: action.value };
    case "start":
      return { ...state, saving: true, error: null };
    case "done":
      return action.outcome === "saved" ? closedSheet : { ...state, saving: false, error: action.outcome, unsaved: true };
  }
}

export type TopupContent = { amountMinor: string; receivedOn: string; note: string | null };
type Target = { leaseId: string; settlementId: string };

/**
 * One request key per entry content. Re-sending the same content (a retry, or the same entry after
 * closing and reopening the sheet) reuses the key, so an attempt that did reach the server is replayed,
 * never recorded twice. Changed content, a saved entry, or a conflict/invalid answer starts a new key.
 * A second send while one is in flight is refused ("busy").
 */
export function createTopupSender(submit: (input: TopupInput) => Promise<TopupResult>, newKey: () => string) {
  let last: { key: string; content: string } | null = null;
  let inflight = false;
  return {
    get key() { return last?.key ?? null; },
    get busy() { return inflight; },
    async send(target: Target, content: TopupContent): Promise<"saved" | TopupError | "busy"> {
      if (inflight) return "busy";
      const signature = JSON.stringify([target.leaseId, target.settlementId, content.amountMinor, content.receivedOn, content.note ?? ""]);
      const key = last && last.content === signature ? last.key : newKey();
      last = { key, content: signature };
      inflight = true;
      let result: TopupResult;
      try {
        result = await submit({ ...target, requestId: key, amountMinor: content.amountMinor, receivedOn: content.receivedOn, note: content.note });
      } catch {
        result = { ok: false, reason: "failed" };
      } finally {
        inflight = false;
      }
      if (result.ok) { last = null; return "saved"; }
      // The same key cannot succeed for these: the entry must be edited, and it then gets a fresh key.
      if (result.reason === "invalid" || result.reason === "conflict") { last = null; return "fix"; }
      return "retry";
    },
  };
}
