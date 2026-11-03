import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { PayDialog } from "@/components/dialogs";
import { ErrorBanner, chargeKey } from "@/components/ui";
import { brandV2EnabledForOrg } from "@/server/brand-v2";
import { electricityMonthLabel, moneyLabel, signedMoney } from "@/server/format";
import { tenantPayeeVisible, unsignedRentNoteKey } from "@/server/pay-note";
import { tenantLeaseMoney } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { selectedLease } from "@/lib/tenant-lease";
import { TenantPayee } from "@/components/tenant-payee";
import { TenantBillSummary, TenantPaymentHistory } from "@/components/tenant-payment-history";
import { tenantPaymentHistoryCopy } from "@/i18n/tenant-payment-history";
import { tenantPaymentHistory } from "@/server/tenant-payment-history";

export const dynamic = "force-dynamic";

export default async function TenantPayPage({ searchParams }: { searchParams: Promise<{ error?: string; done?: string; cursor?: string | string[]; reportId?: string | string[] }> }) {
  await requireCurrentConsent(undefined, "page");
  const { session, lease } = await selectedLease();
  const v2 = await brandV2EnabledForOrg(session.orgId);
  const t = makeT(session.locale);
  const params = await searchParams;
  if (!lease) return <p>{t("i_empty")}</p>;
  const cursor = Array.isArray(params.cursor) ? '!' : params.cursor;
  const reportId = Array.isArray(params.reportId) ? '!' : params.reportId;
  const initialHistory = await tenantPaymentHistory(session, lease.lease_id, { view: 'current' });
  const history = initialHistory.state === 'ready' && (cursor !== undefined || reportId !== undefined)
    ? await tenantPaymentHistory(session, lease.lease_id, { view: 'current', cursor, reportId }) : initialHistory;
  if (history.state === 'unavailable') return <div><h2>{t("i_rich_pay")}</h2><p role="status">{tenantPaymentHistoryCopy(session.locale).unavailable}</p></div>;
  if (history.state === 'ready') {
    return <div>
      <h2>{t("i_rich_pay")}</h2>
      <ErrorBanner t={t} error={params.error} />
      <p>{displaySampleName([lease.property_name, lease.unit_label, lease.room_label].filter(Boolean).join(' '))}</p>
      <TenantBillSummary data={history} locale={session.locale} showLines />
      {history.lease.legacyPayeeVisible && <TenantPayee session={session} leaseId={lease.lease_id} />}
      {history.lease.canReport && <div id="report-payment"><PayDialog leaseId={lease.lease_id} dueMinor={history.bill.balanceMinor} currency={history.bill.currency} label={t("i_report_pay")} returnTo="tenant" /></div>}
      <TenantPaymentHistory data={history} locale={session.locale} pathname="/t/pay" cursor={cursor} selectedReport={reportId} />
      <p className="fn">{t("i_pay_direct", { brand: t("i_brand") })}</p>
    </div>;
  }
  const money = await tenantLeaseMoney(session, lease.lease_id);
  if (!money) return <p>{t("i_empty")}</p>;
  const billEmpty =
    money.rentLines.length === 0 &&
    money.depositLines.length === 0 &&
    money.utilityLines.length === 0 &&
    money.otherLines.length === 0;
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
          {money.depositLines.map((line, index) => (
            <p key={`deposit-${line.amount}-${index}`} data-testid="tenant-deposit-line">
              {t("i_charge_deposit")} {moneyLabel(Number(line.amount), money.currency, session.locale)}
            </p>
          ))}
          {money.utilityLines.map((line, index) => (
            <p key={`${line.description}-${index}`} data-testid="tenant-utility-line">
              {electricityMonthLabel(line.periodStart, line.description && line.description !== "utility" ? line.description : t("i_charge_utility"))}{" "}
              {moneyLabel(Number(line.amount), money.currency, session.locale)}
            </p>
          ))}
          {money.otherLines.map((line, index) => (
            <p key={`other-${line.chargeType}-${index}`} data-testid="tenant-other-line" data-charge-type={line.chargeType}>
              {line.description || t(chargeKey(line.chargeType))} {signedMoney(Number(line.amount), money.currency, session.locale, v2)}
            </p>
          ))}
          <p className="b" data-testid="tenant-bill">{t("i_pay_total")} {moneyLabel(money.dueMinor, money.currency, session.locale)}</p>
          {tenantPayeeVisible(money.lease.status, billEmpty, [...money.rentLines, ...money.depositLines, ...money.utilityLines, ...money.otherLines]) && <TenantPayee session={session} leaseId={lease.lease_id} />}
          {money.dueMinor <= 0 ? (
            <div className="alert ok" data-testid="pay-status">{t("i_pay_settled")}</div>
          ) : (
            <PayDialog
              leaseId={lease.lease_id}
              dueMinor={money.dueMinor}
              currency={money.currency}
              label={t("i_report_pay")}
              returnTo="tenant"
              status={money.paidMinor > 0 ? t("i_pay_partial") : undefined}
            />
          )}
        </>
      )}
      <p className="fn">{t("i_pay_direct", { brand: t("i_brand") })}</p>
    </div>
  );
}
