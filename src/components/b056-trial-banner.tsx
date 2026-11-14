import { b056TrialCopy } from "@/i18n/b056-trial";
import { actionDismissTrialBanner } from "@/server/b056-trial-actions";
import type { trialBannerFor } from "@/server/b056-trial";
import { formatTrialDate } from "@/server/b056-trial-rules";

export function TrialBanner({ locale, banner, next }: {
  locale: string; banner: NonNullable<Awaited<ReturnType<typeof trialBannerFor>>>; next: string;
}) {
  const copy = b056TrialCopy(locale);
  const date = formatTrialDate(banner.endsAt);
  return (
    <div className="callout warn banner" role="status" data-testid="trial-banner">
      <span>{banner.plan === "pro" ? copy.banner_pro(banner.daysLeft, date) : copy.banner_std(banner.daysLeft, date)}</span>
      <span>
        <a className="btn sm" href={`/pricing/apply?plan=${banner.plan}`}>{copy.apply_cta}</a>
        <form action={actionDismissTrialBanner}>
          <input type="hidden" name="kind" value={banner.kind} />
          <input type="hidden" name="next" value={next} />
          <button className="x" type="submit" aria-label={copy.dismiss_label} data-testid="trial-banner-dismiss">×</button>
        </form>
      </span>
    </div>
  );
}
