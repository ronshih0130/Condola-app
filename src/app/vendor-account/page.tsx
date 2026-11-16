import VendorAccountPanel from "./panel";
import { VendorWorkbenchScreen } from "@/components/v3/vendor/workbench-page";
import { currentVendorWorkbench } from "@/server/vendor-workbench";
import { requestPrefs } from "@/server/session";
/**
 * Public shell only. Account data and mutations require the authenticated API.
 * B-063: when the workbench is open for this account session's organization (vendor_workbench + brand_v3 +
 * the B-026 gate), this landing is V-HOME, so every sign-in path (B-026 email, B033/B-101 LINE 「繼續到工作台」)
 * arrives at the workbench. Otherwise the B-026 page renders unchanged.
 */
export default async function VendorAccountPage() {
  const access = await currentVendorWorkbench();
  if (access.state !== "on") return <VendorAccountPanel />;
  return <VendorWorkbenchScreen scope={access.scope} screen="home" locale={(await requestPrefs()).locale} />;
}
