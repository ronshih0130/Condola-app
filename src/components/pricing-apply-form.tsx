// FILE: src/components/pricing-apply-form.tsx
"use client";

// B-045 (pricing_interim) / PLT-30-AC1 (public apply form) + PLT-30-AC2
// (useActionState submit) — the applicant self-serves; a C2 human in /m/admin
// follows up. This component NEVER sends mail/SMS/LINE and NEVER starts
// checkout: it only POSTs the form to the server action, which inserts through
// the SQL entry point. All outbound/notification responsibility stays server-
// and human-side (see pricing-apply-actions.ts).

import { useActionState, useEffect, useRef } from "react";

import { actionSubmitPricingApply } from "@/server/pricing-apply-actions";
import { pricingInterimCopy } from "@/i18n/pricing-interim";
import styles from "./pricing-interim.module.css";

type Props = {
  locale: string;
  defaultPlan?: string | null;
};

// The <select> offers the applicant-facing values: "", "standard", "premium",
// "unsure". The action maps "premium" -> "pro" (validateApplyInput), so when we
// prefill from a stored/linked plan we have to fold "pro" back to "premium".
function planSelectValue(defaultPlan?: string | null): "" | "standard" | "premium" | "unsure" {
  switch (defaultPlan) {
    case "standard":
      return "standard";
    case "premium":
    case "pro":
      return "premium";
    case "unsure":
      return "unsure";
    default:
      return "";
  }
}

export function PricingApplyForm({ locale, defaultPlan }: Props) {
  const copy = pricingInterimCopy(locale);
  const [state, formAction] = useActionState(actionSubmitPricingApply, null);

  // One ref per required field so we can focus the first invalid one on failure
  // (PLT-30-AC2: validation failures return focus state, no insert).
  const companyRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const unitsRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!state || state.ok) return;
    const refs = {
      companyName: companyRef,
      phone: phoneRef,
      units: unitsRef,
    } as const;
    refs[state.first]?.current?.focus();
  }, [state]);

  const errors = state && !state.ok ? state.errors : undefined;
  const planDefault = planSelectValue(defaultPlan);

  return (
    <form action={formAction} data-testid="apply-form" noValidate>
      {/* Company name — required */}
      <div>
        <label htmlFor="apply-companyName">
          {copy.apply.label_company}
          <span aria-hidden="true"> *</span>
        </label>
        <input
          id="apply-companyName"
          name="companyName"
          type="text"
          ref={companyRef}
          required
          aria-required="true"
          aria-invalid={errors?.companyName ? true : undefined}
          aria-describedby={errors?.companyName ? "apply-err-company" : undefined}
        />
        {errors?.companyName ? (
          <p className={styles.err} id="apply-err-company" data-testid="apply-err-company" role="alert">
            {copy.apply.err_company}
          </p>
        ) : null}
      </div>

      {/* Phone — required */}
      <div>
        <label htmlFor="apply-phone">
          {copy.apply.label_phone}
          <span aria-hidden="true"> *</span>
        </label>
        <input
          id="apply-phone"
          name="phone"
          type="tel"
          ref={phoneRef}
          required
          aria-required="true"
          aria-invalid={errors?.phone ? true : undefined}
          aria-describedby={errors?.phone ? "apply-err-phone" : undefined}
        />
        {errors?.phone ? (
          <p className={styles.err} id="apply-err-phone" data-testid="apply-err-phone" role="alert">
            {copy.apply.err_phone}
          </p>
        ) : null}
      </div>

      {/* Units — required, with hint */}
      <div>
        <label htmlFor="apply-units">
          {copy.apply.label_units}
          <span aria-hidden="true"> *</span>
        </label>
        <input
          id="apply-units"
          name="units"
          type="text"
          inputMode="numeric"
          ref={unitsRef}
          required
          aria-required="true"
          aria-invalid={errors?.units ? true : undefined}
          aria-describedby={
            [errors?.units ? "apply-err-units" : null, "apply-hint-units"]
              .filter(Boolean)
              .join(" ") || undefined
          }
        />
        <p id="apply-hint-units" data-testid="apply-hint-units">
          {copy.apply.hint_units}
        </p>
        {errors?.units ? (
          <p className={styles.err} id="apply-err-units" data-testid="apply-err-units" role="alert">
            {copy.apply.err_units}
          </p>
        ) : null}
      </div>

      {/* Plan — optional select; action folds "premium" -> "pro" */}
      <div>
        <label htmlFor="apply-plan">{copy.apply.plan_label}</label>
        <select id="apply-plan" name="plan" defaultValue={planDefault}>
          <option value=""></option>
          <option value="standard">{copy.apply.plan_std}</option>
          <option value="premium">{copy.apply.plan_pre}</option>
          <option value="unsure">{copy.apply.plan_unsure}</option>
        </select>
      </div>

      {/* Note — optional free text */}
      <div>
        <label htmlFor="apply-note">{copy.apply.note_label}</label>
        <textarea id="apply-note" name="note" rows={4} />
      </div>

      {/* Primary submit (PLT-30-AC2). No checkout, no mail — just the action. */}
      <button type="submit" className="btn pri" data-testid="apply-submit" style={{ minHeight: 44 }}>
        {copy.apply.cta}
      </button>

      <p data-testid="apply-foot">{copy.apply.foot}</p>

      {/* Mobile sticky mirror of the submit button. It lives INSIDE the <form>
          so it submits the same fields; CSS (.sticky) keeps it pinned to the
          bottom on phone and hidden on desktop. */}
      <div className={styles.sticky}>
        <button type="submit" className="btn pri" data-testid="apply-sticky-submit" style={{ minHeight: 44 }}>
          {copy.apply.cta}
        </button>
      </div>
    </form>
  );
}
