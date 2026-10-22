import { makeT } from "@/i18n";
import { PayDialog } from "@/components/dialogs";
import { ErrorBanner } from "@/components/ui";
import { moneyLabel } from "@/server/format";
import { unsignedRentNoteKey } from "@/server/pay-note";
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
  const billEmpty = money.rentLines.length === 0 && money.utilityLines.length === 0;
  const noteKey = unsignedRentNoteKey(money.lease.status, billEmpty);
  return (
    <div>
      <h2>{t("i_rich_pay")}</h2>
      <ErrorBanner t={t} error={params.error} />
      {params.done ? <div className="alert ok">{t("i_pay_submitted")}</div> : null}
      <p>
        {displaySampleName(money.lease.place)}
      </p>
      {noteKey ? (
        <p className="small" data-testid="unsigned-rent-note">{t(noteKey)}</p>
      ) : (
        <>
          {money.rentLines.map((line, index) => (
            <p key={`rent-${line.amount}-${index}`} data-testid="tenant-rent-line">
              {t("i_charge_rent")} {moneyLabel(Number(line.amount), money.currency, session.locale)}
            </p>
          ))}
          {money.utilityLines.map((line, index) => (
            <p key={`${line.description}-${index}`} data-testid="tenant-utility-line">
              {line.description} {moneyLabel(Number(line.amount), money.currency, session.locale)}
            </p>
          ))}
          <p className="b" data-testid="tenant-bill">{moneyLabel(money.dueMinor, money.currency, session.locale)}</p>
          <p className="small">{t("i_account_last5", { last5: "88921" })}</p>
          {money.dueMinor > 0 ? (
            <PayDialog leaseId={lease.lease_id} dueMinor={money.dueMinor} currency={money.currency} label={t("i_report_pay")} returnTo="tenant" />
          ) : (
            <div className="alert ok">{t("i_paid_up")}</div>
          )}
        </>
      )}
      <p className="fn">{t("i_pay_direct", { brand: t("i_brand") })}</p>
    </div>
  );
}
