// FILE: src/components/usage-card.tsx
//
// Condola B-045 — Flag-ON usage card for /m/settings (story MGT-53).
// Server component. Optional B-056 trial state is supplied only when pricing_trial is ON.
//
// Acceptance criteria covered:
//   MGT-53-AC1 — Shows the current plan label (免費 / 標準 / 進階) via data-testid="usage-plan".
//   MGT-53-AC2 — Free plan shows "n / 5 戶" with a proportion bar (capped at 100%);
//                paid plans show "n 戶" with NO bar and no "/ 5" (nor "／5") text.
//   MGT-53-AC3 — Metered features (電子簽 / 付費通知 / 對話訊息 / AI) render as
//                「即將提供」 with no numbers; quota digits are never guessed (no_guess).
//   MGT-53-AC4 — Contact (mailto:service@condola.app) + a link to /pricing for plan details.

import Link from "next/link";
import { pricingInterimCopy } from "../i18n/pricing-interim";
import { b056TrialCopy } from "../i18n/b056-trial";

type UsageCardProps = {
  locale: string;
  plan: "free" | "standard" | "pro";
  units: number;
  trial?: { plan: "standard" | "pro"; endsOn: string; daysLeft: number } | null;
  offer?: "admin" | "non_admin" | null;
};

export function UsageCard({ locale, plan, units, trial, offer }: UsageCardProps) {
  const copy = pricingInterimCopy(locale).usage;
  const trialCopy = b056TrialCopy(locale);

  // MGT-53-AC1 — plan label
  const planLabel =
    plan === "free" ? copy.plan_free : plan === "standard" ? copy.plan_std : copy.plan_pre;

  const isFree = !trial && plan === "free";

  // MGT-53-AC2 — free plan fills the proportion bar to n/5, capped at 100%.
  const fillPct = Math.min(100, (units / 5) * 100);

  const meters = [copy.meter_esign, copy.meter_notice, copy.meter_msg, copy.meter_ai];

  return (
    <div className="interim-usage" data-testid="usage-card">
      <h3>{copy.usage_title}</h3>

      {/* MGT-53-AC1 */}
      <p data-testid="usage-plan">{trial ? (trial.plan === "pro" ? trialCopy.plan_trial_pro(trial.endsOn) : trialCopy.plan_trial_std(trial.endsOn)) : planLabel}</p>
      {trial ? <p data-testid="trial-days-left">{trialCopy.days_left(trial.daysLeft)}</p> : null}

      {/* MGT-53-AC2 */}
      {isFree ? (
        <>
          <p data-testid="usage-units">
            {copy.units_label}：{copy.units_free(units)}
          </p>
          <div className="interim-bar">
            <div className="interim-bar-fill" style={{ width: `${fillPct}%` }} />
          </div>
        </>
      ) : (
        <p data-testid="usage-units">
          {copy.units_label}：{copy.units_paid(units)}
        </p>
      )}

      {/* MGT-53-AC3 — metered features, no numbers, no guessed quotas */}
      <ul data-testid="usage-meters">
        {meters.map((label) => (
          <li key={label}>
            {label}：{copy.soon}
          </li>
        ))}
      </ul>

      <p>{copy.no_guess}</p>

      {/* MGT-53-AC4 */}
      <p>
        <a href="mailto:service@condola.app">{copy.contact}</a>
      </p>
      <p>
        <Link href="/pricing">{copy.view_plans}</Link>
      </p>
      {offer === "admin" ? (
        <>
          <div data-testid="trial-start-actions">
            <a className="btn block" href="/m/settings?trial=premium" data-testid="trial-start-pro">{trialCopy.btn_trial_pro}</a>
            <a className="btn o block" href="/m/settings?trial=standard" data-testid="trial-start-std">{trialCopy.btn_trial_std}</a>
          </div>
          <p data-testid="trial-note">{trialCopy.note_admin}</p>
        </>
      ) : offer === "non_admin" ? <p data-testid="trial-note">{trialCopy.note_non_admin}</p> : null}
    </div>
  );
}
