import { tenantLineEntryEnabled } from "@/server/line/tenant-entry";
import { lineTenantCopy } from "@/i18n/line-tenant";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { makeT } from "@/i18n";
import { tenantLeaseHistoryCopy } from "@/i18n/tenant-lease-history";
import { BrandImage } from "@/components/brand";
import { brandV2EnabledForOrg } from "@/server/brand-v2";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { tenantShellView } from "@/server/b090-tenant-shell";
import { TenantShellV3 } from "@/components/v3/tenant/shell";

export const dynamic = "force-dynamic";

export default async function TenantLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const v2 = await brandV2EnabledForOrg(session.orgId);
  if (session.kind !== "tenant") redirect("/m");
  await guardEffectiveSession(session, null);
  const t = makeT(session.locale);
  const path = (await headers()).get("x-pathname") || "";
  await requireCurrentConsent(session, "page", path || "/t");
  // B-090 (OQ-107, REVIEW-CHECKLIST 13): the flag is read after consent and session, before any other data read.
  const v3 = await brandV3EnabledForOrg(session.orgId);
  const lineEnabled = await tenantLineEntryEnabled(session.orgId);
  const task = path === "/t/id" || path.startsWith("/t/id/");
  const backHref = path === "/t/id/notice" || path.startsWith("/t/id/notice/") ? "/t/id" : "/t";
  // B-090 slice 1 (TEN-55-AC1): under brand_v3 the tenant pages sit in the v3 shell with the five phone tabs. The ID
  // task pages keep their focused legacy frame (back link, no tabs). brand_v3 OFF: the legacy frame below, unchanged.
  if (v3 && !task) return <TenantShellV3 locale={session.locale} view={await tenantShellView(session, lineEnabled)}>{children}</TenantShellV3>;
  const tiles = [
    ["/t/pay", "tenant-tile-pay", "i_rich_pay"],
    ["/t/repair", "tenant-tile-repair", "i_rich_repair"],
    ["/t/lease", "tenant-tile-lease", "i_rich_lease"],
    ["/t/messages", "tenant-tile-messages", "i_rich_msg"],
  ] as const;
  return (
    <div className={task ? "stage task" : "stage"}>
      <div className="phone" data-testid="liff-frame">
        <div className="scr">
          {task ? null : <div className="notch" />}
          <div className="lhead">
            {task ? (
              <Link href={backHref} className="task-back" data-testid="task-back">
                {t("i_task_back")}
              </Link>
            ) : null}
            <BrandImage variant="symbolSmall" alt="" className="brand-symbol" {...(v2 ? { v2: true } : {})} />
            {t("i_brand")}
          </div>
          <div className="liffb" data-testid="bill-list">
            {path === "/t" ? (
              <div className="liff-welcome">
                <BrandImage variant="stacked" alt={t("i_brand")} {...(v2 ? { v2: true } : {})} />
              </div>
            ) : null}
            <p><Link href="/t/history" data-testid="tenant-history-link">{tenantLeaseHistoryCopy(session.locale).link}</Link></p>
            {lineEnabled ? <p><Link href={`/t/liff?org=${encodeURIComponent(session.orgId)}&mode=manage`}>{lineTenantCopy(session.locale).manage}</Link></p> : null}
            {children}
          </div>
          {task ? null : (
            <div className="rich" data-testid="tenant-nav">
              <div className="gridm">
                {tiles.map(([href, testid, key]) => (
                  <Link key={href} href={href} data-testid={testid}>
                    {t(key)}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
