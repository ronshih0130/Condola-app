import VendorAccountPanel from "../panel";
import { vendorWorkbenchRoute } from "@/components/v3/vendor/workbench-page";
import { VendorShellV3 } from "@/components/v3/vendor/workbench-shell";
import { requestPrefs } from "@/server/session";
import { cookies } from "next/headers";
import { VendorAddressCard } from "@/components/v3/vendor/vendor-address";
import { SESSION_COOKIE } from "@/server/auth";
import { vendorAddressView } from "@/server/b112-vendor-address";

export const dynamic = "force-dynamic";

/**
 * B-063 OV-SH-MORE / OV-SH-ME 我的帳號: the existing B-026 account page (linked companies, invitation claim,
 * work history), unchanged, inside the vendor shell. Exists only while the workbench is open; OFF is a 404
 * and /vendor-account itself is this page.
 */
export default async function VendorWorkbenchAccountPage() {
  const { locale } = await requestPrefs();
  const route = await vendorWorkbenchRoute(locale);
  if ("page" in route) return route.page;
  // B-112 ven-addr-confirm: the vendor's own address, only when they already have a vendor profile in this org.
  const credential = (await cookies()).get(SESSION_COOKIE)?.value;
  const address = credential ? await vendorAddressView(credential, route.scope.orgId).catch(() => null) : null;
  return <VendorShellV3 locale={locale} name={route.scope.name} company={route.scope.company}>
    {address ? <VendorAddressCard locale={locale} version={address.version} address={address.address} /> : null}
    <VendorAccountPanel />
  </VendorShellV3>;
}
