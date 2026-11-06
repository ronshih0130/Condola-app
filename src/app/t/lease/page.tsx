import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { dictionary, makeT } from "@/i18n";
import { PdfDownloadButton } from "@/components/pdf-download-button";
import { FirstPeriodSummary } from "@/components/first-period-summary";
import { selectedLease } from "@/lib/tenant-lease";
import { formatDate, moneyLabel } from "@/server/format";
import { loadLeaseIdCheck } from "@/server/id-docs";
import { identityRequiredForSigningFor } from "@/server/id-sign-gate";
import { tenantLeaseMoney, tenantSignedLeasePdfs } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { tenantSignedPdfStrings } from "@/i18n/tenant-signed-pdf";
import { signedPdfUploadedAt } from "@/server/paper-lease-history-time";

export const dynamic = "force-dynamic";

export default async function TenantLeasePage() {
  await requireCurrentConsent(undefined, "page");
  const { session, lease } = await selectedLease();
  const t = makeT(session.locale);
  const dict = dictionary(session.locale);
  if (!lease) return <p>{t("i_empty")}</p>;
  const [money, idCheck, signedPdfs] = await Promise.all([
    tenantLeaseMoney(session, lease.lease_id),
    loadLeaseIdCheck(session, lease.lease_id),
    tenantSignedLeasePdfs(session, lease.lease_id),
  ]);
  const idRequired = await identityRequiredForSigningFor(session);
  if (!money) return <p>{t("i_empty")}</p>;
  const signedCopy = tenantSignedPdfStrings(session.locale);
  return (
    <div>
      <h2>{t("i_rich_lease")}</h2>
      <FirstPeriodSummary basis={money.lease.first_period_basis} locale={session.locale} />
      {idCheck && !idCheck.ready && idRequired ? (
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
      {signedPdfs.length > 0 ? (
        <section aria-label={signedCopy.title}>
          <h3>{signedCopy.title}</h3>
          <p>{signedCopy.notice}</p>
          <ul>
            {signedPdfs.map((pdf) => (
              <li key={pdf.id}>
                <span>{pdf.current ? signedCopy.current : signedCopy.historical}</span>
                {" · "}
                <span>
                  {signedCopy.uploaded}: {signedPdfUploadedAt(pdf.created_at, session.locale, session.calendar)?.label}
                </span>
                {" · "}
                <a href={`/t/lease/signed/${pdf.id}`} target="_blank" rel="noopener noreferrer">
                  {signedCopy.view}
                </a>
                {" · "}
                <a href={`/t/lease/signed/${pdf.id}`} download>
                  {signedCopy.download}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
