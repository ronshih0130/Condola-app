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
import { Suspense } from "react";
import type { T } from "@/i18n";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { logServerError } from "@/server/errors";
import { tenantLeaseTerms } from "@/server/b090-tenant-lease-repair";
import { TenantLeaseError, TenantLeaseLoading, TenantLeaseV3 } from "@/components/v3/tenant/lease";
import type { Session } from "@/server/types";

export const dynamic = "force-dynamic";

export default async function TenantLeasePage() {
  await requireCurrentConsent(undefined, "page");
  const { session, lease } = await selectedLease();
  const t = makeT(session.locale);
  const dict = dictionary(session.locale);
  if (!lease) return <p>{t("i_empty")}</p>;
  // B-090 slice 3, RT-LEASE read part (TEN-57-AC1): under brand_v3 the 我的租約 terms card, with today's ID check,
  // PDF, signed copies, first-period summary and firm line kept. brand_v3 OFF: the page below, unchanged.
  if (await brandV3EnabledForOrg(session.orgId)) {
    return <Suspense fallback={<TenantLeaseLoading />}><TenantLeaseV3Body session={session} leaseId={lease.lease_id} /></Suspense>;
  }
  const [money, idCheck, signedPdfs] = await Promise.all([
    tenantLeaseMoney(session, lease.lease_id),
    loadLeaseIdCheck(session, lease.lease_id),
    tenantSignedLeasePdfs(session, lease.lease_id),
  ]);
  const idRequired = await identityRequiredForSigningFor(session);
  if (!money) return <p>{t("i_empty")}</p>;
  return (
    <div>
      <h2>{t("i_rich_lease")}</h2>
      <FirstPeriodSummary basis={money.lease.first_period_basis} locale={session.locale} />
      {idGate(t, Boolean(idCheck && !idCheck.ready && idRequired))}
      {leasePdf(t, lease.lease_id)}
      {signedSection(session, signedPdfs)}
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

// Shared by both versions of the page, so each renders exactly what the page rendered before.
function idGate(t: T, show: boolean) {
  return show ? (
    <div className="card pad" id="idvGate" data-testid="idv-gate">
      <h3>{t("idv_gate_h")}</h3>
      <p>{t("idv_gate")}</p>
      <Link className="btn pri" href="/t/id">
        {t("idv_start")}
      </Link>
    </div>
  ) : null;
}

function leasePdf(t: T, leaseId: string) {
  return (
    <p>
      <PdfDownloadButton
        href={`/api/pdf/leases/${leaseId}`}
        label={t("s_874a842")}
        failed={t("pdf_failed")}
        fontFailed={t("pdf_font_missing")}
        testId="download-lease-pdf"
      />
    </p>
  );
}

function signedSection(session: Session, signedPdfs: Awaited<ReturnType<typeof tenantSignedLeasePdfs>>) {
  const signedCopy = tenantSignedPdfStrings(session.locale);
  return signedPdfs.length > 0 ? (
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
  ) : null;
}

/** RT-LEASE body in its own boundary so the skeleton shows while the readers run (G-LOAD); a failed read is G-ERR. */
async function TenantLeaseV3Body({ session, leaseId }: { session: Session; leaseId: string }) {
  const t = makeT(session.locale);
  let read;
  try {
    const [money, idCheck, signedPdfs] = await Promise.all([
      tenantLeaseMoney(session, leaseId),
      loadLeaseIdCheck(session, leaseId),
      tenantSignedLeasePdfs(session, leaseId),
    ]);
    read = { money, idCheck, signedPdfs, idRequired: await identityRequiredForSigningFor(session) };
  } catch (error) {
    logServerError("b090_tenant_lease", error);
    return <TenantLeaseError locale={session.locale} />;
  }
  const { money, idCheck, signedPdfs, idRequired } = read;
  if (!money) return <p>{t("i_empty")}</p>;
  return (
    <TenantLeaseV3
      terms={tenantLeaseTerms(money)}
      place={displaySampleName(money.lease.place)}
      locale={session.locale}
      calendar={session.calendar}
      before={idGate(t, Boolean(idCheck && !idCheck.ready && idRequired))}
      after={
        <>
          <FirstPeriodSummary basis={money.lease.first_period_basis} locale={session.locale} />
          <div className="t-ls-card t-ls-docs">
            {leasePdf(t, leaseId)}
            {signedSection(session, signedPdfs)}
          </div>
          <p className="fn">{t("i_firm_uses", { firm: money.lease.firm, brand: t("i_brand") })}</p>
        </>
      }
    />
  );
}
