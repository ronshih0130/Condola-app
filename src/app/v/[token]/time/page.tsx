import { notFound } from "next/navigation";
import { VendorLineMatchEntry } from "@/components/v3/vendor/line-match-entry";
import { VendorTokenShell } from "@/components/v3/vendor/token-shell";
import { CaseStyles } from "@/components/v3/vendor/vendor-case";
import { CallTenant } from "@/components/v3/vendor/vendor-done";
import { resolveVendorNotificationEntry } from "@/components/notification-center-entry";
import { vendorCloseCopy } from "@/i18n/lanes/brand-v3-vendor-close";
import { loadVendorCase, vendorCaseStage } from "@/server/b105-vendor-case";
import { vendorTenantPhone } from "@/server/b098-vendor-phone";
import { vendorLineEntryEnabled } from "@/server/line/vendor-entry";
import { requestPrefs } from "@/server/session";
import { loadVendorJob } from "@/server/vendor-repair";
import { vendorTokenBrand } from "@/server/vendor-token-brand";

export const dynamic = "force-dynamic";

/**
 * B-098 RV-TIME (這一案 › 約時間), phone part only: 「打電話給租客」 for the assigned vendor on an open, accepted case
 * (VEN-27-AC3). The tenant-slot line, 「送出時間」 and 「記下電話約好的時間」 need B-088 / B-095 and are not drawn
 * here yet; the RV-JOB 約時間 primary that links to this page comes with them.
 */
export default async function VendorCaseTimePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const job = await loadVendorJob(token);
  if (!job?.vendorLink?.sharingApproved || job.vendorLink.capability === "invalid") notFound();
  const brand = await vendorTokenBrand(token, true);
  if (!brand) notFound();
  const loaded = await loadVendorCase(token);
  if (!loaded || loaded.state !== "ready" || vendorCaseStage(loaded.value) !== "open") notFound();
  const phone = await vendorTenantPhone(token).catch(() => null);
  if (!phone) notFound();
  const prefs = await requestPrefs();
  const notification = await resolveVendorNotificationEntry(token);
  const loginEntry = await vendorLineEntryEnabled(token, true) ? <VendorLineMatchEntry token={token} /> : null;
  const view = <><CaseStyles /><div className="v-token-lead"><h1>{vendorCloseCopy(prefs.locale).timeTitle}</h1></div>
    <section className="v-token-card v-case-card" data-testid="vendor-time">
      {phone.phone ? <CallTenant locale={prefs.locale} phone={phone.phone} /> : null}
    </section></>;
  return <VendorTokenShell locale={prefs.locale} context={brand} notificationHref={notification?.href ?? null} loginEntry={loginEntry}
    title={job.title} address={job.address} window={job.window} status="" reported={false} canReport={false} caseView={view}>
    {null}
  </VendorTokenShell>;
}
