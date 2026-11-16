import React, { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import type { Locale } from "../../../i18n";
import { VENDOR_WORKBENCH } from "../../../lib/vendor-workbench-paths";
import { currentVendorWorkbench, currentVendorWorkbenchView, type VendorWorkbenchScope } from "../../../server/vendor-workbench";
import { VendorAccountSync } from "./account-sync";
import { VendorShellV3 } from "./workbench-shell";
import { VendorHome, VendorJobs, VendorNoPerm, VendorPayments, VendorWorkbenchError, VendorWorkbenchLoading, type VendorWorkbenchScreenId } from "./workbench";

/** The rows are read inside Suspense so the shell and the skeleton show first (VEN-14-AC5). */
async function VendorWorkbenchContent({ scope, screen, locale }: { scope: VendorWorkbenchScope; screen: VendorWorkbenchScreenId; locale: Locale }) {
  const view = await currentVendorWorkbenchView(scope.orgId, locale);
  if (view.status !== "ready") return <VendorWorkbenchError locale={locale} retryHref={VENDOR_WORKBENCH[screen]} />;
  if (screen === "jobs") return <VendorJobs jobs={view.jobs} locale={locale} />;
  if (screen === "payments") return <VendorPayments payments={view.payments} locale={locale} />;
  return <VendorHome jobs={view.jobs} payments={view.payments} locale={locale} />;
}

export function VendorWorkbenchScreen({ scope, screen, locale }: { scope: VendorWorkbenchScope; screen: VendorWorkbenchScreenId; locale: Locale }) {
  return <VendorShellV3 locale={locale} name={scope.name} company={scope.company}>
    <Suspense fallback={<VendorWorkbenchLoading screen={screen} locale={locale} />}>
      <VendorWorkbenchContent scope={scope} screen={screen} locale={locale} />
    </Suspense>
    {screen === "home" ? <VendorAccountSync /> : null}
  </VendorShellV3>;
}

/**
 * Admission for the /vendor-account/* routes, which exist only while the workbench is open. No account
 * session (a job token alone included, VEN-14-AC7): sign in. Terms not current: the consent step. Signed in as
 * someone who is not a vendor account: B1-NOPERM. A vendor whose workbench is not open: 404.
 */
export async function vendorWorkbenchRoute(locale: Locale): Promise<{ scope: VendorWorkbenchScope } | { page: React.ReactElement }> {
  const access = await currentVendorWorkbench();
  if (access.state === "on") return { scope: access.scope };
  if (access.state === "anonymous") redirect(`/login?next=${encodeURIComponent(VENDOR_WORKBENCH.home)}`);
  if (access.state === "consent") redirect(`/consent?next=${encodeURIComponent(VENDOR_WORKBENCH.home)}`);
  if (access.state === "other") return { page: <VendorNoPerm locale={locale} /> };
  notFound();
}
