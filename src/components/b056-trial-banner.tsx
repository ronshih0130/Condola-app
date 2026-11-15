import { brandV3ShellCopy } from "@/i18n/lanes/brand-v3";
import { b056TrialCopy } from "@/i18n/b056-trial";
import { actionDismissTrialBanner } from "@/server/b056-trial-actions";
import type { trialBannerFor } from "@/server/b056-trial";
import { formatTrialDate } from "@/server/b056-trial-rules";

export function TrialBanner({ locale, banner, next, shellV3 = false }: {
  shellV3?: boolean; locale: string; banner: NonNullable<Awaited<ReturnType<typeof trialBannerFor>>>; next: string;
}) {
  const copy = b056TrialCopy(locale);
  const close = shellV3 ? brandV3ShellCopy(locale === "en" ? "en" : "zh-TW").close : copy.dismiss_label;
  const date = formatTrialDate(banner.endsAt);
  return (
    <div className={shellV3 ? "callout warn banner shell-banner shell-trial" : "callout warn banner"} role="status" data-testid="trial-banner">
      <span>{banner.plan === "pro" ? copy.banner_pro(banner.daysLeft, date) : copy.banner_std(banner.daysLeft, date)}</span>
      <span>
        <a className="btn sm" href={`/pricing/apply?plan=${banner.plan}`}>{copy.apply_cta}</a>
        <form action={actionDismissTrialBanner}>
          <input type="hidden" name="kind" value={banner.kind} />
          <input type="hidden" name="next" value={next} />
          <button className="x" type="submit" aria-label={close} data-testid="trial-banner-dismiss">{shellV3 ? close : "×"}</button>
        </form>
      </span>
    </div>
  );
}
