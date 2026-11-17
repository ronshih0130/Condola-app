"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Locale } from "../../../../i18n";
import { brandV3OwnerRulesCopy } from "../../../../i18n/lanes/brand-v3-owner-rules";
import { RENEWAL_RULES, type RenewalRule } from "../../../../server/b091-owner-rules";
import { setOwnerRuleAction } from "../../../../server/b094-owner-rules-actions";

/**
 * RO-RULES 續租 (OWN-34-AC3/AC5): choosing an option saves it; there is no solid primary. While a save is in
 * flight every option is disabled. A failure keeps (shows) the previous rule with 「沒有存成功，請再試一次。」;
 * a stale save shows the rule that is actually stored now.
 */
export function RenewalRuleChoice({ locale, rule, revision }: { locale: Locale; rule: RenewalRule; revision: number }) {
  const copy = brandV3OwnerRulesCopy(locale), router = useRouter();
  const [saved, setSaved] = useState({ rule, revision });
  const [selected, setSelected] = useState<RenewalRule>(rule);
  const [error, setError] = useState(false), [pending, start] = useTransition();
  function choose(next: RenewalRule) {
    if (pending || next === saved.rule) return;
    const previous = saved;
    setSelected(next); setError(false);
    start(async () => {
      try {
        const result = await setOwnerRuleAction({ requestId: crypto.randomUUID(), rule: next, expectedRevision: previous.revision });
        if (result.ok) { setSaved({ rule: result.rule, revision: result.revision }); setSelected(result.rule); router.refresh(); return; }
        if (result.reason === "stale") { setSaved({ rule: result.rule, revision: result.revision }); setSelected(result.rule); }
        else setSelected(previous.rule);
        setError(true);
      } catch { setSelected(previous.rule); setError(true); }
    });
  }
  return <fieldset className="rules-choice" disabled={pending} aria-busy={pending} data-testid="owner-rules-renewal">
    <legend className="rules-section">{copy.renewal}</legend>
    {RENEWAL_RULES.map(option => <label key={option} className={`rules-option${selected === option ? " rules-option-on" : ""}`}>
      <input type="radio" name="renewal-rule" value={option} checked={selected === option} onChange={() => choose(option)} />
      <span>{copy.rules[option]}</span>
    </label>)}
    {error && <p className="rules-error" role="alert">{copy.saveFailed}</p>}
  </fieldset>;
}
