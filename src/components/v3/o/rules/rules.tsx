import React from "react";
import Link from "next/link";
import type { Locale } from "../../../../i18n";
import { brandV3OwnerStateCopy } from "../../../../i18n/lanes/brand-v3";
import { brandV3OwnerDecidedCopy } from "../../../../i18n/lanes/brand-v3-owner-decided";
import { brandV3OwnerRulesCopy } from "../../../../i18n/lanes/brand-v3-owner-rules";
import type { RenewalRule } from "../../../../server/b091-owner-rules";
import type { RepairLimitLine } from "../../../../server/b094-owner-rules";
import { ownerEstimateAmount } from "../../../../server/owner-home-v3";
import { Illustration } from "../../illustrations";
import { RenewalRuleChoice } from "./rule-choice";

/** RO-RULES (更多 › 授權規則, OWN-34). No solid primary: choices save; 「修改」 is a text link. */
export const RULES_HREF = "/o/rules";
export const repairPolicyHref = (propertyId: string) => `/o/repair-policy/${encodeURIComponent(propertyId)}`;
const Title = ({ locale }: { locale: Locale }) => <h2 className="rules-sr">{brandV3OwnerRulesCopy(locale).title}</h2>;

/** OWN-34-AC5 loading: skeletons, and nothing can be changed (no controls render). */
export function RulesLoading({ locale }: { locale: Locale }) {
  return <section className="v3-owner-rules" aria-busy="true" data-testid="owner-rules-loading">
    <Title locale={locale} />
    <div className="rules-card" aria-hidden="true">{[0, 1, 2].map(i => <div className="rules-skeleton" key={i}><span /><span /></div>)}</div>
  </section>;
}
/** O-STATES read error in place, with an outline retry. */
export function RulesError({ locale }: { locale: Locale }) {
  const state = brandV3OwnerStateCopy(locale);
  return <section className="v3-owner-rules" data-testid="owner-rules-error">
    <Title locale={locale} />
    <div className="rules-card" role="alert"><p>{state.error}</p><a className="owner-action" href={RULES_HREF}>{state.retry}</a></div>
  </section>;
}
/** GS-03 / B1-NOPERM: drawing 26, one sentence, one primary back home. */
export function RulesNoPerm({ locale }: { locale: Locale }) {
  const copy = brandV3OwnerDecidedCopy(locale);
  return <section className="v3-owner-rules rules-noperm" data-testid="owner-rules-noperm">
    <Title locale={locale} />
    <Illustration name="26" /><p>{copy.noPerm}</p>
    <Link className="owner-action owner-primary" href="/o">{copy.home}</Link>
  </section>;
}

export function RulesView({ locale, company, repairs, rule, revision }: {
  locale: Locale; company: string; repairs: RepairLimitLine[]; rule: RenewalRule; revision: number;
}) {
  const copy = brandV3OwnerRulesCopy(locale);
  return <section className="v3-owner-rules" data-testid="owner-rules">
    <Title locale={locale} />
    {repairs.length > 0 && <div className="rules-card" data-testid="owner-rules-repairs">
      <h3 className="rules-section">{copy.repairs}</h3>
      <ul className="rules-lines">{repairs.map(line => <li key={line.propertyId} className="rules-line">
        <span>{line.minor === null ? line.name : copy.limit(line.name, ownerEstimateAmount(line.minor, line.currency, line.minorUnit))}</span>
        <Link className="rules-edit" href={repairPolicyHref(line.propertyId)}>{copy.edit}</Link>
      </li>)}</ul>
    </div>}
    <div className="rules-card">
      <RenewalRuleChoice locale={locale} rule={rule} revision={revision} />
      <p className="rules-note">{copy.note(company)}</p>
    </div>
  </section>;
}
