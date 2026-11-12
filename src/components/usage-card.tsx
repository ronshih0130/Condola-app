// FILE: src/components/usage-card.tsx
//
// Condola B-045 — Flag-ON usage card for /m/settings (story MGT-53).
// Server component. No client interactivity, no trial buttons (those are B-056).
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
import styles from "./pricing-interim.module.css";

type UsageCardProps = {
  locale: string;
  plan: "free" | "standard" | "pro";
  units: number;
};

export function UsageCard({ locale, plan, units }: UsageCardProps) {
  const copy = pricingInterimCopy(locale).usage;

  // MGT-53-AC1 — plan label
  const planLabel =
    plan === "free" ? copy.plan_free : plan === "standard" ? copy.plan_std : copy.plan_pre;

  const isFree = plan === "free";

  // MGT-53-AC2 — free plan fills the proportion bar to n/5, capped at 100%.
  const fillPct = Math.min(100, (units / 5) * 100);

  const meters = [copy.meter_esign, copy.meter_notice, copy.meter_msg, copy.meter_ai];

  return (
    <div className={styles.usage} data-testid="usage-card">
      <h3>{copy.usage_title}</h3>

      {/* MGT-53-AC1 */}
      <p data-testid="usage-plan">{planLabel}</p>

      {/* MGT-53-AC2 */}
      {isFree ? (
        <>
          <p data-testid="usage-units">
            {copy.units_label}：{copy.units_free(units)}
          </p>
          <div className={styles.bar}>
            <div className={styles.barFill} style={{ width: `${fillPct}%` }} />
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
    </div>
  );
}
