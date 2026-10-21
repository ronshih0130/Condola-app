import { dictionary, makeT } from "@/i18n";
import { PdfDownloadButton } from "@/components/pdf-download-button";
import { formatDate, formatMoney } from "@/server/format";
import { tenantLeaseMoney } from "@/server/queries";
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
      <p>
        <PdfDownloadButton
          href={`/api/pdf/leases/${lease.lease_id}`}
          label={t("s_874a842")}
          failed={t("pdf_failed")}
          fontFailed={t("pdf_font_missing")}
          testId="download-lease-pdf"
        />
      </p>
      <p>{money.lease.place}</p>
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
