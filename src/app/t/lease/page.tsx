import { dictionary, makeT } from "@/i18n";
import { formatDate, formatMoney } from "@/server/format";
import { tenantLeaseMoney } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { selectedLease } from "@/lib/tenant-lease";

export const dynamic = "force-dynamic";

export default async function TenantLeasePage() {
  const { session, lease } = await selectedLease();
  const t = makeT(session.locale);
  const dict = dictionary(session.locale);
  if (!lease) return <p>{t("i_empty")}</p>;
  const money = await tenantLeaseMoney(session, lease.lease_id);
  if (!money) return <p>{t("i_empty")}</p>;
  return (
    <div>
      <h2>{t("i_rich_lease")}</h2>
      <p>{displaySampleName(money.lease.place)}</p>
      <p>
        {formatDate(money.lease.start_date, session.locale, session.calendar, dict)} – {formatDate(money.lease.end_date, session.locale, session.calendar, dict)}
      </p>
      <p>
        {t("i_rent_label")} {formatMoney(Number(money.lease.rent), money.currency, session.locale)}
      </p>
      <p>
        {t("i_deposit_label")} {formatMoney(Number(money.lease.deposit), money.currency, session.locale)}
      </p>
      <p className="fn">{t("i_firm_uses", { firm: money.lease.firm, brand: t("i_brand") })}</p>
    </div>
  );
}
