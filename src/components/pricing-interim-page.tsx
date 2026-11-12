// FILE: src/components/pricing-interim-page.tsx
//
// Condola B-045 — Flag-ON /pricing view (interim pricing).
// Stories: PLT-26 (display rates), PLT-27 (comparison), PLT-28 (FAQ),
// PLT-29 (trial CTAs), decision C1 (rev 23:37 — trial CTA always shown).
//
// Server component. Approved copy only (pricingInterimCopy); no partner-code /
// personalized prices (Q-F). Does NOT import billing.ts or the old
// PricingCalculator — display math + CTA routing live in b045-pricing-interim-rules.

import Link from "next/link";
import { pricingInterimCopy } from "@/i18n/pricing-interim";
import { trialCtaHref, paidApplyHref } from "@/server/b045-pricing-interim-rules";
import { PricingInterimCalculator } from "./pricing-interim-calculator";
import styles from "./pricing-interim.module.css";

type PricingInterimPageProps = {
  locale: string;
  signedIn: boolean;
  isAdmin: boolean;
  // "/signup" when logged out; null when already signed in (then hide 免費開始).
  freeCtaHref: string | null;
};

export function PricingInterimPage({
  locale,
  signedIn,
  isAdmin,
  freeCtaHref,
}: PricingInterimPageProps) {
  const t = pricingInterimCopy(locale).pricing;

  // Shared per-plan values, reused by the desktop table and the phone cards.
  const planCols = [
    {
      key: "free",
      name: t.plan_free,
      month: t.free_price,
      year: t.year_free_cell,
      billing: t.billing_free,
      unit: t.unit_def,
      admins: t.admins_free,
      trial: t.trial_free_cell,
    },
    {
      key: "standard",
      name: t.plan_std,
      month: t.std_price_month,
      year: t.year_std_cell,
      billing: t.billing_paid,
      unit: t.same,
      admins: t.admins_std,
      trial: t.trial_std_cell,
    },
    {
      key: "premium",
      name: t.plan_pre,
      month: t.pre_price_month,
      year: t.year_pre_cell,
      billing: t.billing_paid,
      unit: t.same,
      admins: t.admins_pre,
      trial: t.trial_pre_cell,
    },
  ] as const;

  // Shared features (same across plans) and metered quotas (not finalized).
  const featRows = [
    t.feat_lease,
    t.feat_pay,
    t.feat_repair,
    t.feat_owner,
    t.feat_line,
    t.feat_esign,
    t.feat_kpi,
    t.feat_billing,
  ];
  const meterRows = [t.meter_esign, t.meter_notice, t.meter_msg, t.meter_ai];

  // Marketing cards for the two paid tiers.
  const paidCards = [
    {
      planKey: "standard" as const,
      cardTestid: "interim-plan-standard",
      name: t.plan_std,
      recommended: true,
      priceMonth: t.std_price_month,
      yearLine: t.std_year_line,
      yearEquiv: t.std_year_equiv,
      fit: t.std_fit,
      admins: t.admins_std,
      trialCell: t.trial_std_cell,
      trialTestid: "interim-trial-standard",
      trialText: t.cta_trial_std,
      applyTestid: "interim-apply-standard",
    },
    {
      planKey: "pro" as const,
      cardTestid: "interim-plan-premium",
      name: t.plan_pre,
      recommended: false,
      priceMonth: t.pre_price_month,
      yearLine: t.pre_year_line,
      yearEquiv: t.pre_year_equiv,
      fit: t.pre_fit,
      admins: t.admins_pre,
      trialCell: t.trial_pre_cell,
      trialTestid: "interim-trial-premium",
      trialText: t.cta_trial_pre,
      applyTestid: "interim-apply-premium",
    },
  ];

  const faqs = [
    [t.faq_unit_q, t.faq_unit_a],
    [t.faq_bill_q, t.faq_bill_a],
    [t.faq_year_q, t.faq_year_a],
    [t.faq_start_q, t.faq_start_a],
    [t.faq_sample_q, t.faq_sample_a],
    [t.faq_admins_q, t.faq_admins_a],
    [t.faq_invoice_q, t.faq_invoice_a],
  ];

  const applyLinkLabel = locale === "zh-TW" ? "申請表" : "application form";

  return (
    <main className={`pricing-page ${styles.root}`} data-testid="interim-pricing">
      <header>
        <h1>{t.title}</h1>
        <p className={styles.lead} data-testid="interim-lead">
          {t.lead}
        </p>
        <p>{t.sub}</p>
      </header>

      {/* Plan cards */}
      <div className={`price-grid ${styles.grid}`}>
        {/* Free */}
        <article className="plan-card" data-testid="interim-plan-free">
          <h2>{t.plan_free}</h2>
          <p className="price">{t.free_price}</p>
          <p className="period">{t.free_period}</p>
          <p className="fit">{t.free_fit}</p>
          <p className="admins">{t.admins_free}</p>
          {freeCtaHref !== null ? (
            <Link
              className="btn pri"
              href={freeCtaHref}
              data-testid="interim-cta-free"
            >
              {t.cta_free}
            </Link>
          ) : null}
        </article>

        {/* Standard + Premium */}
        {paidCards.map((card) => (
          <article
            key={card.planKey}
            className="plan-card"
            data-testid={card.cardTestid}
          >
            {card.recommended ? (
              <span className="badge">{t.badge_rec}</span>
            ) : null}
            <h2>{card.name}</h2>
            <p className="price">
              {card.priceMonth} <span className="period">{t.period_month}</span>
            </p>
            <p className="year-line">{card.yearLine}</p>
            <p className="year-equiv">{card.yearEquiv}</p>
            <p className="fit">{card.fit}</p>
            <p className="admins">{card.admins}</p>
            <p className="trial">
              {t.row_trial}：{card.trialCell}
            </p>
            <Link
              className="btn pri"
              href={trialCtaHref({ plan: card.planKey, signedIn, isAdmin })}
              data-testid={card.trialTestid}
            >
              {card.trialText}
            </Link>
            <Link
              className="btn sec"
              href={paidApplyHref(card.planKey)}
              data-testid={card.applyTestid}
            >
              {t.cta_contact_secondary}
            </Link>
          </article>
        ))}
      </div>

      <p data-testid="interim-trial-note">{t.trial_manual_note}</p>
      <p>{t.formula}</p>

      <PricingInterimCalculator locale={locale} />

      {/* Comparison — desktop table */}
      <section>
        <h2>{t.compare_title}</h2>
        <table className={styles.compare} data-testid="interim-compare">
          <thead>
            <tr>
              <th scope="col"></th>
              {planCols.map((c) => (
                <th key={c.key} scope="col">
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">{t.row_month_price}</th>
              {planCols.map((c) => (
                <td key={c.key}>{c.month}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">{t.row_year}</th>
              {planCols.map((c) => (
                <td key={c.key}>{c.year}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">{t.row_billing}</th>
              {planCols.map((c) => (
                <td key={c.key}>{c.billing}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">{t.row_unit_def}</th>
              {planCols.map((c) => (
                <td key={c.key}>{c.unit}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">{t.row_admins}</th>
              {planCols.map((c) => (
                <td key={c.key}>{c.admins}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">{t.row_trial}</th>
              {planCols.map((c) => (
                <td key={c.key}>{c.trial}</td>
              ))}
            </tr>

            {/* Shared features (same across plans) */}
            <tr>
              <th scope="row" colSpan={4}>
                {t.feat_sec}
              </th>
            </tr>
            {featRows.map((label) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {planCols.map((c) => (
                  <td key={c.key}>{t.feat_yes}</td>
                ))}
              </tr>
            ))}

            {/* Metered quotas — not finalized */}
            {meterRows.map((label) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {planCols.map((c) => (
                  <td key={c.key}>{t.pending}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {/* Comparison — phone cards (CSS hides one or the other) */}
        <div className={styles.compareCards} data-testid="interim-compare-cards">
          {planCols.map((c) => (
            <article
              key={c.key}
              className="compare-card"
              data-testid={`interim-compare-card-${c.key}`}
            >
              <h3>{c.name}</h3>
              <dl>
                <div>
                  <dt>{t.row_month_price}</dt>
                  <dd>{c.month}</dd>
                </div>
                <div>
                  <dt>{t.row_year}</dt>
                  <dd>{c.year}</dd>
                </div>
                <div>
                  <dt>{t.row_billing}</dt>
                  <dd>{c.billing}</dd>
                </div>
                <div>
                  <dt>{t.row_unit_def}</dt>
                  <dd>{c.unit}</dd>
                </div>
                <div>
                  <dt>{t.row_admins}</dt>
                  <dd>{c.admins}</dd>
                </div>
                <div>
                  <dt>{t.row_trial}</dt>
                  <dd>{c.trial}</dd>
                </div>
                {featRows.map((label) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{t.feat_yes}</dd>
                  </div>
                ))}
                {meterRows.map((label) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{t.pending}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>

        <p data-testid="interim-after-table">{t.after_table}</p>
      </section>

      {/* FAQ */}
      <section data-testid="interim-faq">
        {faqs.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}

        {/* The only 設計夥伴 mention; answer links to the apply form. */}
        <details>
          <summary>{t.faq_partner_q}</summary>
          <p>{t.faq_partner_a}</p>
          <p>
            <Link href={paidApplyHref()}>{applyLinkLabel}</Link>
          </p>
        </details>

        <details>
          <summary>{t.faq_activate_q}</summary>
          <p>{t.faq_activate_a}</p>
        </details>
      </section>

      <p>{t.footer_cta}</p>
      <p>{t.legal}</p>

      {/* Mobile sticky CTA — free start only; never trial buttons. */}
      {freeCtaHref !== null ? (
        <div className={styles.sticky}>
          <Link
            className="btn pri"
            href={freeCtaHref}
            data-testid="interim-sticky-free"
          >
            {t.cta_free}
          </Link>
        </div>
      ) : null}
    </main>
  );
}
