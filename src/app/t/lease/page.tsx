import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { dictionary, makeT } from "@/i18n";
import { PdfDownloadButton } from "@/components/pdf-download-button";
import { selectedLease } from "@/lib/tenant-lease";
import { formatDate, moneyLabel } from "@/server/format";
import { loadLeaseIdCheck } from "@/server/id-docs";
import { tenantLeaseMoney } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";

export const dynamic = "force-dynamic";

export default async function TenantLeasePage() {
  await requireCurrentConsent(undefined, "page");
  const { session, lease } = await selectedLease();
  const t = makeT(session.locale);
  const dict = dictionary(session.locale);
  if (!lease) return <p>{t("i_empty")}</p>;
  const [money, idCheck] = await Promise.all([
    tenantLeaseMoney(session, lease.lease_id),
    loadLeaseIdCheck(session, lease.lease_id),
  ]);
  if (!money) return <p>{t("i_empty")}</p>;
  return (
    <div>
      <h2>{t("i_rich_lease")}</h2>
      {idCheck && !idCheck.ready ? (
        <div className="card pad" id="idvGate" data-testid="idv-gate">
          <h3>{t("idv_gate_h")}</h3>
          <p>{t("idv_gate")}</p>
          <Link className="btn pri" href="/t/id">
            {t("idv_start")}
          </Link>
        </div>
      ) : null}
      <p>
        <PdfDownloadButton
          href={`/api/pdf/leases/${lease.lease_id}`}
          label={t("s_874a842")}
          failed={t("pdf_failed")}
          fontFailed={t("pdf_font_missing")}
          testId="download-lease-pdf"
        />
      </p>
      <p>{displaySampleName(money.lease.place)}</p>
      <p>
        {formatDate(money.lease.start_date, session.locale, session.calendar, dict)} – {formatDate(money.lease.end_date, session.locale, session.calendar, dict)}
      </p>
      <p>
        {t("i_rent_label")} {moneyLabel(Number(money.lease.rent), money.currency, session.locale)}
      </p>
      <p>
        {t("i_deposit_label")} {moneyLabel(Number(money.lease.deposit), money.currency, session.locale)}
      </p>
      <p className="fn">{t("i_firm_uses", { firm: money.lease.firm, brand: t("i_brand") })}</p>
    </div>
  );
}
