"use client";
import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Locale } from "../../../../i18n";
import { brandV3OwnerRulesCopy } from "../../../../i18n/lanes/brand-v3-owner-rules";
import { RENEWAL_RULES, type RenewalRule } from "../../../../server/b091-owner-rules-values";
import { setOwnerRuleAction } from "../../../../server/b094-owner-rules-actions";
import { afterSave, startsSave, type ChoiceState } from "./rule-choice-state";

/**
 * RO-RULES 續租 (OWN-34-AC3/AC5): choosing an option saves it; there is no solid primary. Each option is a
 * pressed/unpressed button (not a native radio), so moving with the keyboard never saves the options passed
 * on the way; the group stays focusable while saving (aria-disabled), and a second choice is ignored until the
 * save ends. Outcomes: see afterSave.
 */
export function RenewalRuleChoice({ locale, rule, revision }: { locale: Locale; rule: RenewalRule; revision: number }) {
  const copy = brandV3OwnerRulesCopy(locale), router = useRouter(), legend = useId();
  const [state, setState] = useState<ChoiceState>({ saved: { rule, revision }, selected: rule, error: false });
  const [pending, start] = useTransition();
  const busy = useRef(false);
  function choose(next: RenewalRule) {
    if (!startsSave(busy.current || pending, state.saved.rule, next)) return;
    busy.current = true;
    const previous = state.saved;
    setState({ saved: previous, selected: next, error: false });
    start(async () => {
      let outcome: Parameters<typeof afterSave>[1];
      try { outcome = await setOwnerRuleAction({ requestId: crypto.randomUUID(), rule: next, expectedRevision: previous.revision }); }
      catch { outcome = "threw"; }
      const { refresh, ...nextState } = afterSave(previous, outcome);
      setState(nextState);
      busy.current = false;
      if (refresh) router.refresh();
    });
  }
  return <div className="rules-choice" role="group" aria-labelledby={legend} aria-busy={pending} data-testid="owner-rules-renewal">
    <h3 className="rules-section" id={legend}>{copy.renewal}</h3>
    {RENEWAL_RULES.map(option => <button key={option} type="button" className={`rules-option${state.selected === option ? " rules-option-on" : ""}`}
      aria-pressed={state.selected === option} aria-disabled={pending || undefined} data-rule={option} onClick={() => choose(option)}>
      <span className="rules-mark" aria-hidden="true" /><span>{copy.rules[option]}</span>
    </button>)}
    {state.error && <p className="rules-error" role="alert">{copy.saveFailed}</p>}
  </div>;
}
