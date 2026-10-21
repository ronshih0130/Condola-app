import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { quoteMonthly, formatNt } from "@/server/billing";
import { loadPriceInputs } from "@/server/partners";
import { actionRequestUpgrade } from "@/server/signup-actions";
import { countActiveUnits } from "@/server/sandbox";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function UpgradePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string; tier?: string; code?: string }>;
}) {
  const session = await getSession();
  const query = await searchParams;
  const t = makeT(session.locale);
  const tier = query.tier === "pro" ? "pro" : "standard";
  const inputs = await loadPriceInputs(session.liveOrgId);
  const units = await countActiveUnits(session.liveOrgId);
  const estimate = quoteMonthly({
    units,
    tier,
    cycle: "month",
    now: new Date(),
    override: inputs.override,
    snapshot: inputs.snapshot,
  });
  return (
    <>
      <PageHeader title={t("i_upgrade_title")} />
      <ErrorBanner t={t} error={query.error} />
      <div className="card pad" style={{ maxWidth: 720 }}>
        {query.sent === "1" ? (
          <div className="alert ok" data-testid="upgrade-sent">
            <p>{t("i_upgrade_sent")}</p>
            <p>{t("i_upgrade_bank")}</p>
            <p>{t("i_price_receipt")}</p>
            <p>{t("i_price_open")}</p>
          </div>
        ) : null}
        {query.code === "list" ? <p className="alert warn">{t("i_signup_code_list")}</p> : null}
        <p data-testid="upgrade-estimate">
          {t("i_price_you", { n: units, money: formatNt(estimate.monthly) })}
        </p>
        <form action={actionRequestUpgrade} className="col" data-testid="upgrade-form">
          <label className="radio">
            <input type="radio" name="tier" value="standard" defaultChecked={tier === "standard"} />
            <span>{t("i_price_standard")}</span>
          </label>
          <p className="small" data-testid="upgrade-standard-copy">
            {t("i_price_fit_std")} · {t("i_price_trial")} · {t("i_price_seat_std")}
          </p>
          <label className="radio">
            <input type="radio" name="tier" value="pro" defaultChecked={tier === "pro"} />
            <span>{t("i_price_pro")}</span>
          </label>
          <p className="small" data-testid="upgrade-pro-copy">
            {t("i_price_fit_pro")} · {t("i_price_trial")} · {t("i_price_seat_pro")}
          </p>
          {inputs.code ? (
            <p data-testid="upgrade-code-locked">{t("i_upgrade_code_locked", { name: inputs.partnerName || inputs.code, code: inputs.code })}</p>
          ) : (
            <div className="fg">
              <label className="f">{t("i_signup_code")}</label>
              <input className="inp" name="partnerCode" data-testid="upgrade-code" />
              <div className="hint">{t("i_signup_code_bad")}</div>
            </div>
          )}
          <p className="small">{t("i_upgrade_bank")}</p>
          <p data-testid="upgrade-receipt">{t("i_price_receipt")}</p>
          <button className="btn pri" type="submit" data-testid="upgrade-submit">
            {t("i_upgrade_submit")}
          </button>
        </form>
      </div>
    </>
  );
}
