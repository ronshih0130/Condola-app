import { IdvFlow } from "@/components/idv-flow";
import { ErrorBanner } from "@/components/ui";
import { makeT } from "@/i18n";
import { checkboxLabel, ID_NOTICE_PATH, shortNotice } from "@/lib/id-notice";
import { selectedLease } from "@/lib/tenant-lease";
import { demoModeEnabled } from "@/server/demo";
import { issuePhotoUrls, loadFirmNoticeContact, loadLeaseIdCheck } from "@/server/id-docs";

export const dynamic = "force-dynamic";

export default async function TenantIdPage({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string; compress?: string }> }) {
  const query = await searchParams;
  const { session, lease } = await selectedLease();
  const t = makeT(session.locale);
  if (!lease) return <p>{t("i_empty")}</p>;
  const [check, firm] = await Promise.all([loadLeaseIdCheck(session, lease.lease_id), loadFirmNoticeContact(session)]);
  if (!check) return <p>{t("i_empty")}</p>;
  const locked = check.status === "pending_review" || check.status === "checked";
  const photos = locked && check.documentId ? (await issuePhotoUrls(session, check.documentId)).shots : [];
  const noticeVars = { firmName: firm.name || check.firmName, firmContact: firm.contact, fullNoticeUrl: ID_NOTICE_PATH };
  return (
    <>
      <ErrorBanner t={t} error={query.error} />
      <IdvFlow
        leaseId={lease.lease_id}
        status={check.status}
        docType={check.docType}
        numberMasked={check.numberMasked}
        returnReason={check.returnReason}
        photoUrls={photos}
        demo={demoModeEnabled()}
        compress={demoModeEnabled() && query.compress === "1"}
        sent={query.sent === "1"}
        notice={shortNotice(noticeVars)}
        agreeLabel={checkboxLabel()}
        noticeUrl={ID_NOTICE_PATH}
      />
    </>
  );
}
