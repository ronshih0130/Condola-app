import { VendorWorkbenchScreen, vendorWorkbenchRoute } from "@/components/v3/vendor/workbench-page";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

/** B-063 V-JOBS (工單). Exists only while the workbench is open; OFF is a 404. */
export default async function VendorJobsPage() {
  const { locale } = await requestPrefs();
  const route = await vendorWorkbenchRoute(locale);
  if ("page" in route) return route.page;
  return <VendorWorkbenchScreen scope={route.scope} screen="jobs" locale={locale} />;
}
