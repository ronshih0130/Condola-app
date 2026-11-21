import { notFound } from "next/navigation";
import { VendorLineMatchEntry } from "@/components/v3/vendor/line-match-entry";
import { VendorTokenShell } from "@/components/v3/vendor/token-shell";
import { VendorCasePhotos } from "@/components/v3/vendor/vendor-case-photos";
import { resolveVendorNotificationEntry } from "@/components/notification-center-entry";
import { makeT } from "@/i18n";
import { loadVendorCase, vendorCaseStage } from "@/server/b105-vendor-case";
import { vendorLineEntryEnabled } from "@/server/line/vendor-entry";
import { requestPrefs } from "@/server/session";
import { loadVendorJob } from "@/server/vendor-repair";
import { vendorTokenBrand } from "@/server/vendor-token-brand";

export const dynamic = "force-dynamic";

/** B-105 RV-PHOTOS / RV-PHOTOS-CLOSED (其他 › 處理前／後照片). Exists only while vendor_job_v3 admits this link. */
export default async function VendorCasePhotosPage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ phase?: string }>;
}) {
  const { token } = await params;
  const { phase } = await searchParams;
  const job = await loadVendorJob(token);
  if (!job?.vendorLink?.sharingApproved || job.vendorLink.capability === "invalid") notFound();
  const brand = await vendorTokenBrand(token, true);
  if (!brand) notFound();
  const loaded = await loadVendorCase(token);
  if (!loaded) notFound();
  const stage = loaded.state === "ready" ? vendorCaseStage(loaded.value) : "unavailable";
  // Before 接單 or after a decline the case has no photo page (RV-JOB-ACCEPT lists none).
  if (stage === "accept" || stage === "declined") notFound();
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const notification = await resolveVendorNotificationEntry(token);
  const loginEntry = await vendorLineEntryEnabled(token, true) ? <VendorLineMatchEntry token={token} /> : null;
  const heading = [brand.property, job.title].filter(Boolean).join("・") || t("i_vendor_page_title");
  return <VendorTokenShell locale={prefs.locale} context={brand} notificationHref={notification?.href ?? null} loginEntry={loginEntry}
    title={job.title} address={job.address} window={job.window} status="" reported={false} canReport={false}
    caseView={<VendorCasePhotos locale={prefs.locale} token={token} heading={heading}
      phase={phase === "before" ? "before" : "after"} value={loaded.state === "ready" ? loaded.value : null}
      messages={{ size: t("i_photo_size"), type: t("i_photo_type"), heic: t("i_photo_heic"), limit: t("i_photo_limit") }} />}>
    {null}
  </VendorTokenShell>;
}
