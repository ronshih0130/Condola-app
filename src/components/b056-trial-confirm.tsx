import { b056TrialCopy } from "@/i18n/b056-trial";
import { actionStartTrial } from "@/server/b056-trial-actions";
import type { TrialPlan } from "@/server/b056-trial-rules";

export function TrialConfirm({ locale, plan, endsOn }: { locale: string; plan: TrialPlan; endsOn: string }) {
  const copy = b056TrialCopy(locale);
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="trial-confirm-title" data-testid="trial-confirm">
      <div className="panel">
        <h1 id="trial-confirm-title">{plan === "pro" ? copy.confirm_title_pro : copy.confirm_title_std}</h1>
        <p>{plan === "pro" ? copy.confirm_body_pro(endsOn) : copy.confirm_body_std(endsOn)}</p>
        <div className="acts">
          <a className="btn o sm" href="/m/settings">{copy.cancel}</a>
          <form action={actionStartTrial}>
            <input type="hidden" name="plan" value={plan} />
            <button className="btn sm" type="submit" data-testid="trial-confirm-submit">{copy.confirm}</button>
          </form>
        </div>
      </div>
    </div>
  );
}
