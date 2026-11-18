import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { WaitMark } from "@/components/v3/wait-mark";
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
import { getSession } from "@/server/session";
import { actionRecordPayment } from "@/server/actions";
import { TenantPayV3Route } from "@/components/v3/tenant/pay-route";

export const dynamic = "force-dynamic";

export default async function TenantPayPage({ searchParams }: { searchParams: Promise<{ error?: string; done?: string; cursor?: string | string[]; reportId?: string | string[]; report?: string | string[] }> }) {
  await requireCurrentConsent(undefined, "page");
  // B-090 (OQ-107, REVIEW-CHECKLIST 13): the flag is read right after consent and session, before any data read.
  const current = await getSession();
  const v3 = await brandV3EnabledForOrg(current.orgId);
  const { session, lease } = await selectedLease(current);
  const v2 = await brandV2EnabledForOrg(session.orgId);
  const t = makeT(session.locale);
  const params = await searchParams;
  if (!lease) return <p>{t("i_empty")}</p>;
  /** The existing 繳款 body (brand_v3 OFF, and brand_v3 ON while the payment-history gate is off), unchanged. */
  const legacyPay = async () => {
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
        <TenantPaymentHistory v3={v3} data={history} locale={session.locale} pathname="/t/pay" cursor={cursor} selectedReport={reportId} />
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
        {params.done ? <div className="alert ok">{v3 ? <WaitMark /> : null}{t("i_pay_submitted")}</div> : null}
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
  };
  // B-090 slice 2, RT-PAY / RT-REPORT (TEN-52, TEN-53): under brand_v3 the 繳款 page and the 回報已繳 form, which posts to
  // the existing report action. While tenant_payment_history is not live for the org the v3 reader answers "off" and
  // the existing body above renders inside the v3 shell. brand_v3 OFF: the existing body, unchanged.
  if (v3) {
    return <TenantPayV3Route session={session} leaseId={lease.lease_id} company={lease.firm_name} brand={t("i_brand")} action={actionRecordPayment}
      place={displaySampleName([lease.property_name, lease.unit_label, lease.room_label].filter(Boolean).join(' '))}
      report={params.report === "1"} errorKey={typeof params.error === "string" && params.error ? params.error : undefined} legacy={legacyPay} />;
  }
  return legacyPay();
}
