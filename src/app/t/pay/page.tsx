import { makeT } from "@/i18n";
import { PayDialog } from "@/components/dialogs";
import { ErrorBanner } from "@/components/ui";
import { moneyLabel as formatMoney } from "@/server/format";
import { tenantLeaseMoney } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { selectedLease } from "@/lib/tenant-lease";

export const dynamic = "force-dynamic";

export default async function TenantPayPage({ searchParams }: { searchParams: Promise<{ error?: string; done?: string }> }) {
  const { session, lease } = await selectedLease();
  const t = makeT(session.locale);
  const params = await searchParams;
  if (!lease) return <p>{t("i_empty")}</p>;
  const money = await tenantLeaseMoney(session, lease.lease_id);
  if (!money) return <p>{t("i_empty")}</p>;
  return (
    <div>
      <h2>{t("i_rich_pay")}</h2>
      <ErrorBanner t={t} error={params.error} />
      {params.done ? <div className="alert ok">{t("i_pay_submitted")}</div> : null}
      <p>
        {displaySampleName(money.lease.place)}
      </p>
      {money.utilityLines.map((line, index) => (
        <p key={`${line.description}-${index}`} data-testid="tenant-utility-line">
          {line.description} {formatMoney(Number(line.amount), money.currency, session.locale)}
        </p>
      ))}
      <p className="b" data-testid="tenant-bill">{formatMoney(money.dueMinor, money.currency, session.locale)}</p>
      <p className="small">{t("i_account_last5", { last5: "88921" })}</p>
      {money.dueMinor > 0 ? (
        <PayDialog leaseId={lease.lease_id} dueMinor={money.dueMinor} currency={money.currency} label={t("i_report_pay")} returnTo="tenant" />
      ) : (
        <div className="alert ok">{t("i_paid_up")}</div>
      )}
      <p className="fn">{t("i_pay_direct", { brand: t("i_brand") })}</p>
    </div>
  );
}
