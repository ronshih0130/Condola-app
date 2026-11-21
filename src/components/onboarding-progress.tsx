import React from "react";
import { makeT, type Locale } from "@/i18n";
import type { EmptyCta } from "@/lib/empty-cta";
import type { SetupProgress } from "@/server/onboarding-progress";
import { EmptyPrimary } from "./empty-state";

export function OnboardingProgress({ progress, locale, cta }: { progress: SetupProgress; locale: Locale; cta: EmptyCta }) {
  const checklist = progress.checklist;
  if (!checklist || !progress.checklistOn) return null;
  const t = makeT(locale);
  const steps = <ol className="setup-steps">{checklist.steps.map((step, index) =>
    <li key={step.id} className={step.done ? "done" : step.index === progress.step ? "current" : ""}
      aria-current={!step.done && step.index === progress.step ? "step" : undefined}>
      <span className="setup-number" aria-hidden="true">{step.done ? "✓" : index + 1}</span><span>{t(step.key)}
        {step.index === 3 && progress.step === 3 ? <small>{t("es_setup_wait")}</small> : null}</span>
    </li>)}</ol>;
  if (checklist.completedAt) return <details className="setup-checklist setup-complete" data-testid="live-onboarding">
    <summary><span aria-hidden="true">✓ </span><strong>{t("es_setup_done")}</strong>・{t("es_setup_collapsed")} <span className="es-view">{t("es_setup_view")}</span></summary>
    {steps}
  </details>;
  return <section className="setup-checklist" data-testid="live-onboarding">
    <h2>{t("es_setup_title")} <span>{checklist.completed}／{checklist.total}</span></h2>
    <progress max={checklist.total || 1} value={checklist.completed} aria-label={t("es_setup_title")} />
    {steps}
    {progress.hasUnits && progress.step >= 2 && progress.step < 4 && cta.primary ? <EmptyPrimary action={cta.primary} locale={locale} /> : null}
  </section>;
}
