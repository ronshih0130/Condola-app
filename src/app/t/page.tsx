import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { makeT } from "@/i18n";
import { actionPickLease } from "@/server/actions";
import { moneyLabel } from "@/server/format";
import { loadLeaseIdCheck } from "@/server/id-docs";
import { tenantLeaseMoney, tenantLeases } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function TenantHome() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  const leases = await tenantLeases(session);
  if (leases.length > 1 && !session.leaseId) {
    return (
      <div data-testid="lease-picker">
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
  if (!lease) return <p>{t("i_empty")}</p>;
  const [money, idCheck] = await Promise.all([
    tenantLeaseMoney(session, lease.lease_id),
    loadLeaseIdCheck(session, lease.lease_id),
  ]);
  const rentMinor = money?.lease.rent ?? "0";
  const depositMinor = money?.lease.deposit ?? "0";
  const dueMinor = money?.dueMinor ?? 0;
  const currency = money?.lease.currency ?? "TWD";
  const pendingUnsigned = (money?.lease.status ?? lease.lease_status) === "pending_signature";
  return (
    <div>
      <h2>{t("i_hello", { name: session.name })}</h2>
      <p>
        {lease.firm_name} · {displaySampleName(`${lease.property_name} ${lease.room_label ?? ""}`)}
      </p>
      {idCheck && !idCheck.ready ? (
        <p>
          <Link className="btn block" href="/t/id" data-testid="idv-home-link">
            {t("idv_start")}
          </Link>
          <span className="small">{t("idv_gate")}</span>
        </p>
      ) : null}
      {pendingUnsigned ? (
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
      <p className="small">{t("i_addr_managed", { address: displaySampleName(lease.address_display ?? lease.property_name), firm: lease.firm_name })}</p>
      <p className="fn">{t("i_pay_direct", { brand: t("i_brand") })}</p>
    </div>
  );
}
