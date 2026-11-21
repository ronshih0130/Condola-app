import { notFound } from "next/navigation";
import { VendorLineMatchEntry } from "@/components/v3/vendor/line-match-entry";
import { VendorTokenShell } from "@/components/v3/vendor/token-shell";
import { CaseStyles } from "@/components/v3/vendor/vendor-case";
import { VendorDoneForm } from "@/components/v3/vendor/vendor-done";
import { resolveVendorNotificationEntry } from "@/components/notification-center-entry";
import { makeT } from "@/i18n";
import { vendorCaseCopy } from "@/i18n/lanes/brand-v3-vendor-case";
import { loadVendorCase, vendorCaseStage } from "@/server/b105-vendor-case";
import { loadVendorDone } from "@/server/b097-vendor-close";
import { vendorLineEntryEnabled } from "@/server/line/vendor-entry";
import { requestPrefs } from "@/server/session";
import { loadVendorJob } from "@/server/vendor-repair";
import { vendorTokenBrand } from "@/server/vendor-token-brand";

export const dynamic = "force-dynamic";

/** B-097 RV-DONE (這一案 › 回報完工). Exists only while vendor_job_v3 admits this link and the case is accepted and open. */
export default async function VendorCaseDonePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const job = await loadVendorJob(token);
  if (!job?.vendorLink?.sharingApproved || job.vendorLink.capability === "invalid") notFound();
  const brand = await vendorTokenBrand(token, true);
  if (!brand) notFound();
  const loaded = await loadVendorCase(token);
  if (!loaded || (loaded.state === "ready" && vendorCaseStage(loaded.value) !== "open")) notFound();
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const done = loaded.state === "ready" ? await loadVendorDone(token).catch(() => undefined) : undefined;
  if (done === null || done?.closed || done?.accepted === false) notFound();
  const notification = await resolveVendorNotificationEntry(token);
  const loginEntry = await vendorLineEntryEnabled(token, true) ? <VendorLineMatchEntry token={token} /> : null;
  const caseCopy = vendorCaseCopy(prefs.locale);
  const view = done ? <VendorDoneForm locale={prefs.locale} token={token} company={done.company} photos={done.afterPhotos}
    messages={{ size: t("i_photo_size"), type: t("i_photo_type"), heic: t("i_photo_heic"), limit: t("i_photo_limit") }} />
    : <><CaseStyles /><div className="v-case-error" role="alert"><p>{caseCopy.readError}</p>
      <a className="v-token-secondary" href={`/v/${encodeURIComponent(token)}/done`}>{caseCopy.retry}</a></div></>;
  return <VendorTokenShell locale={prefs.locale} context={brand} notificationHref={notification?.href ?? null} loginEntry={loginEntry}
    title={job.title} address={job.address} window={job.window} status="" reported={false} canReport={false} caseView={view}>
    {null}
  </VendorTokenShell>;
}
