import type { RenewalRule } from "../../../../server/b091-owner-rules-values";

/** What the B-091 save answered, as the client sees it (a thrown action is "threw"). Pure: no server imports. */
export type SaveOutcome =
  | { ok: true; rule: RenewalRule; revision: number }
  | { ok: false; reason: "stale"; rule: RenewalRule; revision: number }
  | { ok: false; reason: string }
  | "threw";
export type ChoiceState = { saved: { rule: RenewalRule; revision: number }; selected: RenewalRule; error: boolean };

/**
 * OWN-34-AC5: success stores the answered rule; stale shows the rule that is stored now; every other failure
 * (including a thrown action) keeps the previous rule. Every failure shows 「沒有存成功，請再試一次。」.
 */
export function afterSave(previous: ChoiceState["saved"], outcome: SaveOutcome): ChoiceState & { refresh: boolean } {
  if (outcome !== "threw" && outcome.ok) return { saved: { rule: outcome.rule, revision: outcome.revision }, selected: outcome.rule, error: false, refresh: true };
  if (outcome !== "threw" && outcome.reason === "stale" && "rule" in outcome)
    return { saved: { rule: outcome.rule, revision: outcome.revision }, selected: outcome.rule, error: true, refresh: false };
  return { saved: previous, selected: previous.rule, error: true, refresh: false };
}
/** A choice starts a save only when nothing is saving and it differs from the stored rule. */
export function startsSave(pending: boolean, saved: RenewalRule, next: RenewalRule): boolean {
  return !pending && next !== saved;
}
/**
 * A newer stored revision from the server (after refresh, or a change elsewhere) replaces the local state, but
 * only while nothing is saving, and never rolls back to an older revision. No remount, so focus stays put.
 */
export function syncFromServer(state: ChoiceState, busy: boolean, rule: RenewalRule, revision: number): ChoiceState {
  if (busy || revision <= state.saved.revision) return state;
  return { saved: { rule, revision }, selected: rule, error: false };
}
