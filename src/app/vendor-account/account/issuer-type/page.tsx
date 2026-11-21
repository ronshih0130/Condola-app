import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { vendorWorkbenchRoute } from "@/components/v3/vendor/workbench-page";
import { VendorShellV3 } from "@/components/v3/vendor/workbench-shell";
import { SESSION_COOKIE } from "@/server/auth";
import { vendorIssuerType } from "@/server/b065-vendor-activation";
import { requestPrefs } from "@/server/session";
import { vendorActivationCopy } from "@/i18n/lanes/brand-v3-vendor-activation";
import { IssuerTypeForm } from "@/components/v3/vendor/vendor-activation";

export const dynamic = "force-dynamic";

/** B-065 我的帳號 › 開立類型 (VEN-17-AC1, AC5…AC7; GS-31). 404 unless vendor_activation admits this account. */
export default async function VendorIssuerTypePage() {
  const { locale } = await requestPrefs();
  const route = await vendorWorkbenchRoute(locale);
  if ("page" in route) return route.page;
  const credential = (await cookies()).get(SESSION_COOKIE)?.value;
  const current = credential ? await vendorIssuerType(credential, route.scope.orgId).catch(() => undefined) : undefined;
  if (current === undefined) notFound();
  const copy = vendorActivationCopy(locale);
  return <VendorShellV3 locale={locale} name={route.scope.name} company={route.scope.company}>
    {/* eslint-disable-next-line @next/next/no-css-tags -- workbench-only stylesheet */}
    <link rel="stylesheet" href="/brand/v3/vendor-activation.css" />
    <h1 className="v-act-h1">{copy.title}</h1>
    <p className="v-act-crumb">{copy.crumb}</p>
    <IssuerTypeForm locale={locale} current={current} />
  </VendorShellV3>;
}
