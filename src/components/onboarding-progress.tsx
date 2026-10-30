import { onboardingStrings } from "@/i18n/onboarding-progress";
import { actionSaveOnboardingChoices } from "@/server/onboarding-progress-actions";
import { readOnboarding } from "@/server/onboarding-progress";
import { onboardingGroups } from "@/server/onboarding-progress-rules";
import type { Session } from "@/server/types";

export async function OnboardingProgress({ session }: { session: Session }) {
  const progress = await readOnboarding(session);
  if (!progress) return null;
  const s = onboardingStrings(session.locale);
  const state = (done: boolean) => done ? s.done : s.incomplete;
  return <section className="card pad" data-testid="live-onboarding" style={{ marginBottom: 16 }}>
    <h2>{s.title}</h2>
    <ul>
      <li>{s.property}: {state(progress.counts.properties > 0)}</li>
      <li>{s.lease}: {state(progress.counts.leases > 0)} ({s.drafts}: {progress.counts.drafts})</li>
      <li>{s.bill}: {state(progress.counts.bills > 0)}</li>
      {onboardingGroups.map((group) => {
        const status = progress.groups?.[group];
        const label = status === "complete" ? s.done : status === "skipped" ? s.skipped : status === "incomplete" ? s.incomplete : s.decision;
        return <li key={group}>{s[group]}: {label} ({s.counts}: {progress.counts[`${group}_ready`]} / {progress.counts[`${group}_total`]}); {s.pending}: {progress.counts[`${group}_pending`]}; {s.expired}: {progress.counts[`${group}_expired`]}</li>;
      })}
    </ul>
    <form action={actionSaveOnboardingChoices}>
      <p>{s.decision}</p><p className="hint">{s.help}</p>
      {onboardingGroups.map((group) => <label className="row" key={group}><input type="checkbox" name={group} defaultChecked={progress.policy?.required[group] ?? false} /> {s[group]} — {s.required}</label>)}
      <button className="btn" type="submit">{s.save}</button>
    </form>
  </section>;
}
