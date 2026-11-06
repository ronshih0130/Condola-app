import { NotificationCenterEntry } from "@/components/notification-center-entry";
import { HandoverEntry } from "@/components/handover-entry";
import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { makeT } from "@/i18n";
import { actionPickLease } from "@/server/actions";
import { brandV2EnabledForOrg } from "@/server/brand-v2";
import { moneyLabel } from "@/server/format";
import { loadLeaseIdCheck } from "@/server/id-docs";
import { identityRequiredForSigningFor } from "@/server/id-sign-gate";
import { tenantLeaseMoney, tenantLeases } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";
import { tenantDuePreference } from "@/server/tenant-reminder-preferences";
import { reminderCopy } from "@/i18n/lanes/reminders";
import { tenantPaymentHistory } from "@/server/tenant-payment-history";
import { TenantBillSummary } from "@/components/tenant-payment-history";
import { tenantPaymentHistoryCopy } from "@/i18n/tenant-payment-history";

export const dynamic = "force-dynamic";

export default async function TenantHome() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const v2 = await brandV2EnabledForOrg(session.orgId);
  const t = makeT(session.locale);
  const leases = await tenantLeases(session);
  if (leases.length > 1 && !session.leaseId) {
    return (
      <div data-testid="lease-picker" data-v2-page={v2 ? "t-home" : undefined}>
        <h2>{t("i_select_lease")}</h2>
        <p className="small">{t("i_pick_hint")}</p>
        {leases.map((lease) => (
          <form key={lease.lease_id} action={actionPickLease}>
            <input type="hidden" name="leaseId" value={lease.lease_id} />
            <button className="card pad" type="submit" style={{ width: "100%", textAlign: "left", marginBottom: 8 }}>
              <b>{lease.firm_name}</b>
              <div className="small">
                {displaySampleName([lease.property_name, lease.unit_label, lease.room_label].filter(Boolean).join(" "))}
              </div>
            </button>
          </form>
        ))}
      </div>
    );
  }
  const lease = leases.find((item) => item.lease_id === session.leaseId) ?? leases[0];
  if (!lease) return <p data-v2-page={v2 ? "t-home" : undefined}>{t("i_empty")}</p>;
  const [history, idCheck, reminderPreference] = await Promise.all([
    tenantPaymentHistory(session, lease.lease_id, { view: 'current' }),
    loadLeaseIdCheck(session, lease.lease_id),
    tenantDuePreference(session,lease.lease_id),
  ]);
  const idRequired = await identityRequiredForSigningFor(session);
  const money = history.state === "off" ? await tenantLeaseMoney(session, lease.lease_id) : null;
  const rentMinor = money?.lease.rent ?? "0";
  const depositMinor = money?.lease.deposit ?? "0";
  const dueMinor = money?.dueMinor ?? 0;
  const currency = money?.lease.currency ?? "TWD";
  const pendingUnsigned = (money?.lease.status ?? lease.lease_status) === "pending_signature";
  return (
    <div data-v2-page={v2 ? "t-home" : undefined}>
      <h2>{t("i_hello", { name: session.name })}</h2>
      <p>
        {lease.firm_name} · {displaySampleName(`${lease.property_name} ${lease.room_label ?? ""}`)}
      </p>
      {idCheck && !idCheck.ready && idRequired ? (
        <p>
          <Link className="btn block" href="/t/id" data-testid="idv-home-link">
            {t("idv_start")}
          </Link>
          <span className="small">{t("idv_gate")}</span>
        </p>
      ) : null}
      {history.state === 'unavailable' ? <p role="status">{tenantPaymentHistoryCopy(session.locale).unavailable}</p> : history.state === 'ready' ? <div data-testid="rent-due-notice"><TenantBillSummary data={history} locale={session.locale} /><Link className="fbtn" href="/t/pay">{t("i_rich_pay")}</Link></div> : pendingUnsigned ? (
        <p className="small" data-testid="unsigned-rent-note">{t("i_pay_unsigned_bill")}</p>
      ) : (
        <div className="flex" data-testid="rent-due-notice">
          <div className="fh">{t("i_pay_total")}</div>
          <div className="fb">
            <div className="big" data-testid="rent-due-amount" data-minor={dueMinor}>
              {moneyLabel(dueMinor, currency, session.locale)}
            </div>
            <div className="small" data-testid="rent-due-rent" data-minor={rentMinor}>
              {t("s_b6c3113")} {moneyLabel(rentMinor, currency, session.locale)}
            </div>
            <div className="small" data-testid="rent-due-deposit" data-minor={depositMinor}>
              {t("s_8b17769")} {moneyLabel(depositMinor, currency, session.locale)}
            </div>
          </div>
          <Link className="fbtn" href="/t/pay">
            {t("i_rich_pay")}
          </Link>
        </div>
      )}
      {reminderPreference !== null ? <p><Link href={`/t/reminders/${lease.lease_id}`} data-testid="tenant-reminder-settings">{reminderCopy(session.locale).tenantTitle}</Link></p> : null}
      <HandoverEntry session={session} leaseId={lease.lease_id} />
      <NotificationCenterEntry session={session} />
      <p className="small">{t("i_addr_managed", { address: displaySampleName(lease.address_display ?? lease.property_name), firm: lease.firm_name })}</p>
      <p className="fn">{t("i_pay_direct", { brand: t("i_brand") })}</p>
    </div>
  );
}
